package dev.codeintelligence.analysis.core;

import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.source.SourceStoreClient;
import dev.codeintelligence.source.SourceStoreException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Optional;
import java.util.UUID;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectInserter;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/** Exact retained source reads; callers resolve project ownership before entering this reader. */
@Service
public class RetainedSnapshotReader {
    private final SourceStoreClient client;
    private final JdbcClient jdbc;
    private final AnalysisProperties analysis;

    public RetainedSnapshotReader(SourceStoreClient client, JdbcClient jdbc, AnalysisProperties analysis) {
        this.client = client;
        this.jdbc = jdbc;
        this.analysis = analysis;
    }

    /** Empty means a legacy snapshot with no retained manifest, not a missing retained file. */
    public Optional<String> read(long projectId, long snapshotId, String path, String gitOid, long byteSize) {
        int sourceVersion = jdbc.sql(
                        "select source_contract_version from snapshots where id=:snapshot and project_id=:project")
                .param("project", projectId)
                .param("snapshot", snapshotId)
                .query(Integer.class)
                .optional()
                .orElseThrow(SnapshotSourceException::unavailable);
        var manifests = jdbc.sql(
                        "select id,sealed_at is not null as sealed from source_manifests where project_id=:project and snapshot_id=:snapshot")
                .param("project", projectId)
                .param("snapshot", snapshotId)
                .query((rs, row) -> new Manifest(rs.getObject("id", UUID.class), rs.getBoolean("sealed")))
                .list();
        if (manifests.isEmpty() && sourceVersion == 0) return Optional.empty();
        if (manifests.isEmpty() || sourceVersion != 1) throw SnapshotSourceException.unavailable();
        Manifest manifest = manifests.getFirst();
        if (!manifest.sealed()) throw SnapshotSourceException.unavailable();
        if (byteSize > analysis.maxFileSize()) throw new FileTooLargeException();
        String hash = jdbc.sql(
                        "select e.blob_sha256 from source_manifest_entries e join source_blobs b "
                                + "on b.project_id=e.project_id and b.sha256=e.blob_sha256 and b.byte_size=e.byte_size "
                                + "where e.manifest_id=:manifest and e.project_id=:project and e.path=:path and e.git_oid=:oid and e.byte_size=:size")
                .param("manifest", manifest.id())
                .param("project", projectId)
                .param("path", path)
                .param("oid", gitOid)
                .param("size", byteSize)
                .query(String.class)
                .optional()
                .orElseThrow(SnapshotSourceException::stale);
        byte[] bytes;
        try {
            bytes = client.read(projectId, hash, byteSize);
        } catch (SourceStoreException error) {
            throw SnapshotSourceException.unavailable();
        }
        try (var formatter = new ObjectInserter.Formatter()) {
            if (!formatter.idFor(Constants.OBJ_BLOB, bytes).name().equals(gitOid))
                throw SnapshotSourceException.stale();
        }
        if (BinaryFiles.isBinary(path, bytes)) throw new BinaryFileException();
        try {
            return Optional.of(StandardCharsets.UTF_8
                    .newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString());
        } catch (CharacterCodingException error) {
            throw SnapshotSourceException.encoding();
        }
    }

    private record Manifest(UUID id, boolean sealed) {}
}
