package dev.codeintelligence.project;

import dev.codeintelligence.evidence.EvidenceKind;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.evidence.EvidenceSubjects;
import dev.codeintelligence.evidence.NewEvidence;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;

/** Persists one bounded count-only observation; these counts do not measure analysis success. */
@Service
public class LocalImportDiagnostics {
    static final int MAX_JSON_BYTES = 2048;
    private final EvidenceService evidence;
    private final JsonMapper json;

    public LocalImportDiagnostics(EvidenceService evidence, JsonMapper json) {
        this.evidence = evidence;
        this.json = json;
    }

    public void record(long projectId, long snapshotId, LocalImportService.ImportSummary summary) {
        String excerpt = json.writeValueAsString(summary);
        if (excerpt.getBytes(StandardCharsets.UTF_8).length > MAX_JSON_BYTES) {
            throw new IllegalStateException("Local import diagnostic exceeds its size limit.");
        }
        evidence.replaceLinked(
                projectId,
                EvidenceSubjects.LOCAL_IMPORT,
                snapshotId,
                List.of(new NewEvidence(EvidenceKind.CONFIG, null, null, null, excerpt)));
    }
}
