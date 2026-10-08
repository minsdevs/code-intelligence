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
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/** Process-lifetime keys include every solver-visible file and configuration; nothing is written to disk. */
final class JavaInputFingerprint {
    private JavaInputFingerprint() {}

    record Snapshot(String complete, String environment, Map<String, String> files) {}

    static Snapshot capture(AnalysisContext context) {
        if (context.clonePath() == null) return null;
        MessageDigest complete = digest();
        MessageDigest environment = digest();
        update(complete, Long.toString(context.projectId()));
        update(environment, Long.toString(context.projectId()));
        update(complete, context.inventory().files().toString());
        Set<String> javaPaths = context.inventory().files().stream()
                .filter(file -> "java".equalsIgnoreCase(file.language()) || file.path().toLowerCase(java.util.Locale.ROOT).endsWith(".java"))
                .map(file -> file.path()).collect(Collectors.toSet());
        Map<String, String> files = new LinkedHashMap<>();
        Path root = context.clonePath().toAbsolutePath().normalize();
        try (var paths = Files.walk(root)) {
            byte[] buffer = new byte[8192];
            for (Path path : paths.sorted().toList()) {
                JobCancellation.checkpoint();
                if (Files.isSymbolicLink(path)) return null;
                String relative = root.relativize(path).toString().replace('\\', '/');
                update(complete, relative);
                update(environment, relative);
                if (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) continue;
                if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) return null;
                MessageDigest content = digest();
                try (var input = Files.newInputStream(path)) {
                    int size;
                    while ((size = input.read(buffer)) != -1) {
                        JobCancellation.checkpoint();
                        content.update(buffer, 0, size);
                    }
                }
                String hash = HexFormat.of().formatHex(content.digest());
                update(complete, hash);
                if (javaPaths.contains(relative)) files.put(relative, hash);
                else update(environment, hash);
            }
            return new Snapshot(HexFormat.of().formatHex(complete.digest()),
                    HexFormat.of().formatHex(environment.digest()), Map.copyOf(files));
        } catch (IOException failure) {
            return null;
        }
    }

    static MessageDigest digest() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    static String hash(String value) {
        MessageDigest digest = digest();
        update(digest, value);
        return HexFormat.of().formatHex(digest.digest());
    }

    static void update(MessageDigest digest, String value) {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        int length = bytes.length;
        digest.update((byte) (length >>> 24));
        digest.update((byte) (length >>> 16));
        digest.update((byte) (length >>> 8));
        digest.update((byte) length);
        digest.update(bytes);
    }
}
