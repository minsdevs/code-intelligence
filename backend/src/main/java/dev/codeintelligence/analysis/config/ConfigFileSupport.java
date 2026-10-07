package dev.codeintelligence.analysis.config;

import dev.codeintelligence.analysis.core.InvalidFilePathException;
import dev.codeintelligence.analysis.core.SafeRelativePath;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;

final class ConfigFileSupport {

    static final int EXCERPT_LEN = 80;

    private ConfigFileSupport() {}

    static String filename(String path) {
        String normalized = path.replace('\\', '/');
        int slash = normalized.lastIndexOf('/');
        return slash < 0 ? normalized : normalized.substring(slash + 1);
    }

    static String read(Path clonePath, String relative) {
        try {
            Path resolved = SafeRelativePath.resolve(clonePath, relative);
            if (!Files.isRegularFile(resolved)) {
                return null;
            }
            return Files.readString(resolved, StandardCharsets.UTF_8);
        } catch (InvalidFilePathException | IOException e) {
            return null;
        }
    }

    static String excerpt(String text) {
        if (text == null) {
            return "";
        }
        String stripped = text.strip();
        int nl = stripped.indexOf('\n');
        if (nl >= 0) {
            stripped = stripped.substring(0, nl).strip();
        }
        if (stripped.length() > EXCERPT_LEN) {
            return stripped.substring(0, EXCERPT_LEN);
        }
        return stripped;
    }

    /**
     * Number of the line holding the last character: LF, CRLF and a lone CR end a line, and a final terminator does not
     * open another one. An empty file still spans line 1.
     */
    static int lineCount(String text) {
        int lines = 1;
        int last = text.length() - 1;
        for (int i = 0; i < last; i++) {
            char c = text.charAt(i);
            if (c == '\n' || (c == '\r' && text.charAt(i + 1) != '\n')) {
                lines++;
            }
        }
        return lines;
    }

    static int lineOf(String text, String token) {
        if (text == null || token == null || token.isBlank()) {
            return 1;
        }
        String[] lines = text.split("\n", -1);
        String needle = token.toLowerCase(Locale.ROOT);
        for (int i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase(Locale.ROOT).contains(needle)) {
                return i + 1;
            }
        }
        return 1;
    }

    static String sanitize(String message, Path clonePath) {
        if (message == null) {
            return "";
        }
        String cleaned = message.replace('\n', ' ');
        if (clonePath != null) {
            cleaned = cleaned.replace(clonePath.toString(), "");
        }
        if (cleaned.length() > 240) {
            return cleaned.substring(0, 240);
        }
        return cleaned.strip();
    }
}
