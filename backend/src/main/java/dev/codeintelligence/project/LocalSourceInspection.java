package dev.codeintelligence.project;

import java.util.Map;

/** One bounded inspection; the binding is private, while the summary contains counts only. */
public record LocalSourceInspection(
        LocalSourceBinding binding, Map<String, String> gitFingerprints, LocalImportService.ImportSummary summary) {
    public LocalSourceInspection {
        gitFingerprints = Map.copyOf(gitFingerprints);
    }
}
