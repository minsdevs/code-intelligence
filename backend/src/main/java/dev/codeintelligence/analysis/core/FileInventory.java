package dev.codeintelligence.analysis.core;

import java.util.List;
import java.util.Locale;

/** Snapshot file list handed to {@link CodeAnalyzer#supports(FileInventory)}. */
public record FileInventory(List<InventoriedFile> files) {

    public FileInventory {
        files = files == null ? List.of() : List.copyOf(files);
    }

    public static FileInventory of(List<InventoriedFile> files) {
        return new FileInventory(files);
    }

    public static FileInventory of(InventoriedFile file) {
        return new FileInventory(List.of(file));
    }

    public boolean isEmpty() {
        return files.isEmpty();
    }

    public boolean hasLanguage(String language) {
        if (language == null) {
            return false;
        }
        String expected = language.toLowerCase(Locale.ROOT);
        return files.stream().anyMatch(file -> expected.equalsIgnoreCase(file.language()));
    }
}
