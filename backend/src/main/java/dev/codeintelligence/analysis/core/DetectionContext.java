package dev.codeintelligence.analysis.core;

import dev.codeintelligence.common.LanguageDetector;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;
import java.util.function.Predicate;

public final class DetectionContext {

    private final List<InventoriedFile> files;
    private final String manifestText;
    private final Function<String, String> contentReader;

    public DetectionContext(List<InventoriedFile> files, String manifestText, Function<String, String> contentReader) {
        this.files = List.copyOf(files);
        this.manifestText = manifestText == null ? "" : manifestText.toLowerCase(Locale.ROOT);
        this.contentReader = contentReader == null ? path -> null : contentReader;
    }

    public static DetectionContext of(List<String> paths, String manifestText, Map<String, String> contents) {
        List<InventoriedFile> files = paths.stream()
                .map(path -> new InventoriedFile(path, LanguageDetector.detect(path), 0, 0, ""))
                .toList();
        return new DetectionContext(files, manifestText, contents::get);
    }

    public List<InventoriedFile> files() {
        return files;
    }

    public boolean isEmpty() {
        return files.isEmpty();
    }

    public boolean anyPath(Predicate<String> predicate) {
        return files.stream().anyMatch(file -> predicate.test(file.path()));
    }

    public boolean anyPathMatches(String glob) {
        return anyPath(path -> PathGlobs.matches(path, glob));
    }

    public Optional<InventoriedFile> firstMatching(String glob) {
        return files.stream()
                .filter(file -> PathGlobs.matches(file.path(), glob))
                .findFirst();
    }

    public long countMatching(String glob) {
        return files.stream()
                .filter(file -> PathGlobs.matches(file.path(), glob))
                .count();
    }

    public boolean mentions(String token) {
        return manifestText.contains(token.toLowerCase(Locale.ROOT));
    }

    public String content(String path) {
        return contentReader.apply(path);
    }

    public Optional<InventoriedFile> firstContaining(String glob, String... needles) {
        for (InventoriedFile file : files) {
            if (!PathGlobs.matches(file.path(), glob)) {
                continue;
            }
            String text = content(file.path());
            if (text == null) {
                continue;
            }
            for (String needle : needles) {
                if (text.contains(needle)) {
                    return Optional.of(file);
                }
            }
        }
        return Optional.empty();
    }

    public String excerpt(String path, String needle, int maxLen) {
        String text = content(path);
        if (text == null) {
            return needle;
        }
        int idx = text.indexOf(needle);
        if (idx < 0) {
            String trimmed = text.strip();
            return trimmed.length() <= maxLen ? trimmed : trimmed.substring(0, maxLen);
        }
        int start = Math.max(0, idx);
        int end = Math.min(text.length(), start + maxLen);
        return text.substring(start, end).replace('\n', ' ').strip();
    }

    public Integer lineOf(String path, String needle) {
        String text = content(path);
        if (text == null) {
            return null;
        }
        int idx = text.indexOf(needle);
        if (idx < 0) {
            return 1;
        }
        int line = 1;
        for (int i = 0; i < idx; i++) {
            if (text.charAt(i) == '\n') {
                line++;
            }
        }
        return line;
    }
}
