package dev.codeintelligence.project;

import java.time.Instant;
import java.util.List;

/**
 * Only the opaque one-use token and safe inspection summary cross the API boundary. Languages and
 * top-level directories count the approved files; {@code scope} is the narrowing the token binds.
 */
public record LocalSourcePreview(
        String previewToken,
        Instant expiresAt,
        String operation,
        String sourceName,
        Long snapshotId,
        Changes changes,
        List<String> changedPaths,
        LocalImportService.ImportSummary localImport,
        List<LanguageCount> languages,
        List<DirectoryCount> directories,
        LocalImportScope scope) {
    public LocalSourcePreview {
        changedPaths = List.copyOf(changedPaths);
        languages = List.copyOf(languages);
        directories = List.copyOf(directories);
    }

    public record Changes(int added, int modified, int deleted, int total) {
        static Changes of(int added, int modified, int deleted) {
            return new Changes(added, modified, deleted, added + modified + deleted);
        }
    }

    /** Approved files of one inventory language and the depth this installation is expected to analyze. */
    public record LanguageCount(String language, int files, String expectedDepth) {}

    /** Approved files below one top-level directory; {@code "."} counts files directly in the root. */
    public record DirectoryCount(String name, int files) {}
}
