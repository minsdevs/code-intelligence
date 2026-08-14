package dev.codeintelligence.analysis.core;

import java.util.Locale;
import java.util.Set;

public final class BinaryFiles {

    private static final Set<String> EXTENSIONS = Set.of(
            "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "pdf", "zip", "jar", "war", "ear", "class", "woff",
            "woff2", "eot", "ttf", "otf", "mp3", "mp4", "webm", "mov", "avi", "wav", "ogg", "exe", "dll", "so", "dylib",
            "bin", "7z", "tar", "gz", "bz2", "rar", "xz", "sqlite", "db", "wasm", "pyc", "o", "a", "lib");

    private static final int SNIFF_BYTES = 8192;

    private BinaryFiles() {}

    public static boolean isBinary(String path, byte[] content) {
        if (hasBinaryExtension(path)) {
            return true;
        }
        int n = Math.min(content.length, SNIFF_BYTES);
        for (int i = 0; i < n; i++) {
            if (content[i] == 0) {
                return true;
            }
        }
        return false;
    }

    public static boolean hasBinaryExtension(String path) {
        String ext = extension(path);
        return ext != null && EXTENSIONS.contains(ext);
    }

    private static String extension(String path) {
        if (path == null) {
            return null;
        }
        String normalized = path.replace('\\', '/');
        int slash = normalized.lastIndexOf('/');
        String filename = slash >= 0 ? normalized.substring(slash + 1) : normalized;
        int dot = filename.lastIndexOf('.');
        if (dot < 0 || dot == filename.length() - 1) {
            return null;
        }
        return filename.substring(dot + 1).toLowerCase(Locale.ROOT);
    }
}
