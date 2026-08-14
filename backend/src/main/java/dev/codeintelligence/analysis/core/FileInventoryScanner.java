package dev.codeintelligence.analysis.core;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.ObjectLoader;
import org.eclipse.jgit.revwalk.RevCommit;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.treewalk.TreeWalk;
import org.springframework.stereotype.Component;

@Component
public class FileInventoryScanner {

    public InventoryResult scan(java.nio.file.Path clonePath, int maxFiles, long maxFileSize) throws IOException {
        List<InventoriedFile> files = new ArrayList<>();
        int skippedForCount = 0;
        int skippedForSize = 0;
        int skippedBinary = 0;
        try (Git git = Git.open(clonePath.toFile());
                RevWalk revWalk = new RevWalk(git.getRepository());
                TreeWalk treeWalk = new TreeWalk(git.getRepository())) {
            ObjectId head = git.getRepository().resolve(Constants.HEAD);
            if (head == null) {
                return new InventoryResult(List.of(), 0, 0, 0);
            }
            RevCommit commit = revWalk.parseCommit(head);
            treeWalk.addTree(commit.getTree());
            treeWalk.setRecursive(true);
            while (treeWalk.next()) {
                long size = git.getRepository().open(treeWalk.getObjectId(0)).getSize();
                if (files.size() >= maxFiles) {
                    skippedForCount++;
                    continue;
                }
                if (size > maxFileSize) {
                    skippedForSize++;
                    continue;
                }
                ObjectLoader loader = git.getRepository().open(treeWalk.getObjectId(0));
                byte[] bytes = loader.getBytes();
                String path = treeWalk.getPathString();
                if (BinaryFiles.isBinary(path, bytes)) {
                    skippedBinary++;
                    continue;
                }
                files.add(new InventoriedFile(
                        path,
                        LanguageDetector.detect(path),
                        size,
                        countLines(bytes),
                        treeWalk.getObjectId(0).name()));
            }
        }
        return new InventoryResult(List.copyOf(files), skippedForCount, skippedForSize, skippedBinary);
    }

    static int countLines(byte[] bytes) {
        if (bytes.length == 0) {
            return 0;
        }
        int lines = 0;
        for (byte b : bytes) {
            if (b == '\n') {
                lines++;
            }
        }
        if (bytes[bytes.length - 1] != '\n') {
            lines++;
        }
        return lines;
    }

    static String asText(byte[] bytes) {
        return new String(bytes, StandardCharsets.UTF_8);
    }
}
