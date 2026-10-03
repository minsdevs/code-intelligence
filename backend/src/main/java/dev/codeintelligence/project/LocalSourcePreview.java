package dev.codeintelligence.project;

import java.time.Instant;
import java.util.List;

/** Only the opaque one-use token and safe inspection summary cross the API boundary. */
public record LocalSourcePreview(
        String previewToken,
        Instant expiresAt,
        String operation,
        String sourceName,
        Long snapshotId,
        Changes changes,
        List<String> changedPaths,
        LocalImportService.ImportSummary localImport) {
    public LocalSourcePreview {
        changedPaths = List.copyOf(changedPaths);
    }

    public record Changes(int added, int modified, int deleted, int total) {
        static Changes of(int added, int modified, int deleted) {
            return new Changes(added, modified, deleted, added + modified + deleted);
        }
    }
}
