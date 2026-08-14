package dev.codeintelligence.analysis.core;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;

public final class SafeRelativePath {

    private SafeRelativePath() {}

    public static String normalize(String requested) {
        if (requested == null || requested.isBlank()) {
            throw new InvalidFilePathException();
        }
        if (requested.indexOf('\0') >= 0) {
            throw new InvalidFilePathException();
        }
        String path = requested.replace('\\', '/');
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.contains("%2e") || lower.contains("%2f") || lower.contains("%5c")) {
            throw new InvalidFilePathException();
        }
        if (path.startsWith("/") || path.matches("^[A-Za-z]:.*")) {
            throw new InvalidFilePathException();
        }
        Path relative;
        try {
            relative = Path.of(path);
        } catch (RuntimeException e) {
            throw new InvalidFilePathException();
        }
        if (relative.isAbsolute()) {
            throw new InvalidFilePathException();
        }
        for (Path part : relative) {
            if ("..".equals(part.toString())) {
                throw new InvalidFilePathException();
            }
        }
        Path normalized = relative.normalize();
        if (normalized.isAbsolute() || normalized.startsWith("..")) {
            throw new InvalidFilePathException();
        }
        String rendered = normalized.toString().replace('\\', '/');
        if (rendered.isBlank() || rendered.equals(".")) {
            throw new InvalidFilePathException();
        }
        return rendered;
    }

    public static Path resolve(Path root, String requested) {
        String path = normalize(requested);
        Path relative = Path.of(path);
        Path rootNorm = root.toAbsolutePath().normalize();
        Path resolved = rootNorm.resolve(relative).normalize();
        if (!resolved.startsWith(rootNorm) || resolved.equals(rootNorm)) {
            throw new InvalidFilePathException();
        }
        try {
            if (Files.exists(resolved) && Files.exists(rootNorm)) {
                Path realRoot = rootNorm.toRealPath();
                Path realTarget = resolved.toRealPath();
                if (!realTarget.startsWith(realRoot) || realTarget.equals(realRoot)) {
                    throw new InvalidFilePathException();
                }
                return realTarget;
            }
        } catch (IOException e) {
            throw new InvalidFilePathException();
        }
        return resolved;
    }
}
