package dev.codeintelligence.analysis.java;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.job.JobCancellation;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/** Process-lifetime keys include the entire solver-visible workspace, not just inventoried Java. */
final class JavaInputFingerprint {
    private JavaInputFingerprint() {}

    static String compute(AnalysisContext context) {
        if (context.clonePath() == null) return null;
        MessageDigest digest = digest();
        update(digest, Long.toString(context.projectId()));
        update(digest, context.inventory().files().toString());
        Path root = context.clonePath().toAbsolutePath().normalize();
        try (var paths = Files.walk(root)) {
            byte[] buffer = new byte[8192];
            for (Path path : paths.sorted().toList()) {
                JobCancellation.checkpoint();
                if (Files.isSymbolicLink(path)) return null;
                update(digest, root.relativize(path).toString());
                if (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) continue;
                if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) return null;
                try (var input = Files.newInputStream(path)) {
                    int size;
                    while ((size = input.read(buffer)) != -1) {
                        JobCancellation.checkpoint();
                        digest.update(buffer, 0, size);
                    }
                }
                digest.update((byte) 0);
            }
            return HexFormat.of().formatHex(digest.digest());
        } catch (IOException failure) {
            return null;
        }
    }

    static MessageDigest digest() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    static void update(MessageDigest digest, String value) {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        digest.update(java.nio.ByteBuffer.allocate(4).putInt(bytes.length).array());
        digest.update(bytes);
    }
}
