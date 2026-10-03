package dev.codeintelligence.analysis.core;

import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.common.AppProperties;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import org.eclipse.jgit.errors.CorruptObjectException;
import org.eclipse.jgit.errors.IncorrectObjectTypeException;
import org.eclipse.jgit.errors.MissingObjectException;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.ObjectInserter;
import org.eclipse.jgit.lib.ObjectLoader;
import org.eclipse.jgit.lib.ObjectReader;
import org.eclipse.jgit.lib.Repository;
import org.eclipse.jgit.storage.file.FileRepositoryBuilder;
import org.springframework.stereotype.Component;

/** Reads only the authenticated inventory's Git blob; never consults a working-tree file. */
@Component
public final class SnapshotBlobReader {
    private final AppProperties app;
    private final AnalysisProperties analysis;

    public SnapshotBlobReader(AppProperties app, AnalysisProperties analysis) {
        this.app = app;
        this.analysis = analysis;
    }

    public String read(String clonePath, String path, String storedOid, long inventorySize) {
        if (storedOid == null || !ObjectId.isId(storedOid)) throw SnapshotSourceException.unknown();
        long limit = Math.min(analysis.maxFileSize(), Integer.MAX_VALUE - 8L);
        if (inventorySize > limit) throw new FileTooLargeException();
        if (inventorySize < 0) throw SnapshotSourceException.stale();
        if (clonePath == null) throw SnapshotSourceException.unavailable();
        ObjectId oid = ObjectId.fromString(storedOid);
        try {
            Path repos = app.reposRoot().toRealPath();
            Path clone = Path.of(clonePath).toAbsolutePath().normalize();
            if (!clone.startsWith(app.reposRoot()) || clone.equals(app.reposRoot()))
                throw new InvalidFilePathException();
            Path realClone = clone.toRealPath();
            if (!realClone.startsWith(repos) || realClone.equals(repos)) throw new InvalidFilePathException();
            Path git = realClone.resolve(".git");
            // Managed imports are standalone repositories, never worktree indirections/alternates.
            if (!Files.isDirectory(git, LinkOption.NOFOLLOW_LINKS)
                    || Files.isSymbolicLink(git.resolve("objects"))
                    || Files.exists(git.resolve("objects/info/alternates"), LinkOption.NOFOLLOW_LINKS)) {
                throw SnapshotSourceException.unavailable();
            }
            try (Repository repository = new FileRepositoryBuilder()
                            .setGitDir(git.toFile())
                            .setMustExist(true)
                            .build();
                    ObjectReader reader = repository.newObjectReader()) {
                // Force streaming even for small loose objects: eager loading trusts the object header
                // before we can enforce bounds and detect a malformed payload/header length.
                reader.setStreamFileThreshold(0);
                if (reader.getObjectSize(oid, Constants.OBJ_BLOB) > limit) throw new FileTooLargeException();
                ObjectLoader loader = reader.open(oid, Constants.OBJ_BLOB);
                long size = loader.getSize();
                if (size > limit) throw new FileTooLargeException();
                byte[] bytes;
                try (InputStream input = loader.openStream()) {
                    // Inspect the advertised length AND at most limit+1 actual bytes; no getBytes/readAllBytes.
                    bytes = input.readNBytes((int) Math.min(size + 1, limit + 1));
                    if (bytes.length > limit) throw new FileTooLargeException();
                    if (bytes.length != size || input.read() != -1) throw SnapshotSourceException.stale();
                }
                if (bytes.length != inventorySize) throw SnapshotSourceException.stale();
                try (ObjectInserter.Formatter formatter = new ObjectInserter.Formatter()) {
                    if (!formatter.idFor(Constants.OBJ_BLOB, bytes).equals(oid)) throw SnapshotSourceException.stale();
                }
                if (BinaryFiles.isBinary(path, bytes)) throw new BinaryFileException();
                for (byte value : bytes) if (value == 0) throw new BinaryFileException();
                try {
                    return StandardCharsets.UTF_8
                            .newDecoder()
                            .onMalformedInput(CodingErrorAction.REPORT)
                            .onUnmappableCharacter(CodingErrorAction.REPORT)
                            .decode(ByteBuffer.wrap(bytes))
                            .toString();
                } catch (CharacterCodingException e) {
                    throw SnapshotSourceException.encoding();
                }
            }
        } catch (MissingObjectException e) {
            throw SnapshotSourceException.unavailable();
        } catch (IncorrectObjectTypeException | CorruptObjectException | ArrayIndexOutOfBoundsException e) {
            // JGit 7.3 also reports an overlong loose-object header as an array bounds error.
            throw SnapshotSourceException.stale();
        } catch (IOException e) {
            // A concurrent refresh/delete may retire the object database. Do not follow the new worktree.
            throw SnapshotSourceException.unavailable();
        }
    }
}
