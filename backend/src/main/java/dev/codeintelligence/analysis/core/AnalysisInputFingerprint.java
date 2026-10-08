package dev.codeintelligence.analysis.core;

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
public final class AnalysisInputFingerprint {
    private AnalysisInputFingerprint() {}

    public record Snapshot(String complete, String environment, Map<String, String> files) {}

    public static Snapshot capture(AnalysisContext context) {
        if (context.clonePath() == null) return null;
        MessageDigest complete = digest();
        MessageDigest environment = digest();
        update(complete, Long.toString(context.projectId()));
        update(environment, Long.toString(context.projectId()));
        for (InventoriedFile file : context.inventory().files()) {
            if (isMetadata(Path.of(file.path()))) return null;
            update(complete, file.path());
            update(complete, String.valueOf(file.language()));
            update(complete, String.valueOf(file.size()));
            update(complete, String.valueOf(file.lineCount()));
            update(complete, String.valueOf(file.contentHash()));
        }
        Set<String> javaPaths = context.inventory().files().stream()
                .filter(file -> "java".equalsIgnoreCase(file.language())
                        || file.path().toLowerCase(java.util.Locale.ROOT).endsWith(".java"))
                .map(file -> file.path())
                .collect(Collectors.toSet());
        Map<String, String> files = new LinkedHashMap<>();
        Path root = context.clonePath().toAbsolutePath().normalize();
        try (var paths = Files.walk(root)) {
            byte[] buffer = new byte[8192];
            for (Path path : paths.filter(path -> !isMetadata(root.relativize(path)))
                    .sorted()
                    .toList()) {
                checkpoint();
                if (Files.isSymbolicLink(path)) return null;
                String relative = root.relativize(path).toString().replace('\\', '/');
                update(complete, Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS) ? "directory" : "file");
                update(environment, Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS) ? "directory" : "file");
                update(complete, relative);
                update(environment, relative);
                if (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) continue;
                if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) return null;
                MessageDigest content = digest();
                try (var input = Files.newInputStream(path)) {
                    int size;
                    while ((size = input.read(buffer)) != -1) {
                        checkpoint();
                        content.update(buffer, 0, size);
                    }
                }
                String hash = HexFormat.of().formatHex(content.digest());
                update(complete, hash);
                if (javaPaths.contains(relative)) files.put(relative, hash);
                else if (!isForeignSource(relative)) update(environment, hash);
            }
            return new Snapshot(
                    HexFormat.of().formatHex(complete.digest()),
                    HexFormat.of().formatHex(environment.digest()),
                    Map.copyOf(files));
        } catch (IOException | java.io.UncheckedIOException | SecurityException failure) {
            return null;
        }
    }

    private static boolean isForeignSource(String relative) {
        String name = relative.toLowerCase(java.util.Locale.ROOT);
        return name.endsWith(".js")
                || name.endsWith(".jsx")
                || name.endsWith(".mjs")
                || name.endsWith(".cjs")
                || name.endsWith(".ts")
                || name.endsWith(".tsx")
                || name.endsWith(".mts")
                || name.endsWith(".cts");
    }

    public static MessageDigest digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    public static String hash(String value) {
        MessageDigest digest = digest();
        update(digest, value);
        return HexFormat.of().formatHex(digest.digest());
    }

    public static void update(MessageDigest digest, String value) {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        int length = bytes.length;
        digest.update((byte) (length >>> 24));
        digest.update((byte) (length >>> 16));
        digest.update((byte) (length >>> 8));
        digest.update((byte) length);
        digest.update(bytes);
    }

    public static boolean isMetadata(Path relative) {
        for (Path part : relative) if (part.toString().equals(".git")) return true;
        return false;
    }

    public static void checkpoint() {
        JobCancellation.checkpoint();
        if (Thread.currentThread().isInterrupted()) throw new dev.codeintelligence.job.JobCancelledException();
    }
}
