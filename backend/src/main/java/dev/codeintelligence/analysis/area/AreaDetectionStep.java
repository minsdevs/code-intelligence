package dev.codeintelligence.analysis.area;

import dev.codeintelligence.analysis.core.DetectionContext;
import dev.codeintelligence.analysis.core.DetectionContextFactory;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.evidence.EvidenceSubjects;
import dev.codeintelligence.evidence.NewEvidence;
import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobStep;
import java.util.ArrayList;
import java.util.List;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

@Component
@Order(AreaDetectionStep.ORDER)
public class AreaDetectionStep implements JobStep {

    public static final String KEY = "AREA_DETECTION";
    public static final int ORDER = 400;

    private final DetectionContextFactory detectionContextFactory;
    private final AreaDetectionEngine engine;
    private final JdbcClient jdbc;
    private final TransactionTemplate transactionTemplate;
    private final EvidenceService evidenceService;

    public AreaDetectionStep(
            DetectionContextFactory detectionContextFactory,
            AreaDetectionEngine engine,
            JdbcClient jdbc,
            TransactionTemplate transactionTemplate,
            EvidenceService evidenceService) {
        this.detectionContextFactory = detectionContextFactory;
        this.engine = engine;
        this.jdbc = jdbc;
        this.transactionTemplate = transactionTemplate;
        this.evidenceService = evidenceService;
    }

    @Override
    public String key() {
        return KEY;
    }

    @Override
    public void run(JobContext ctx) {
        long snapshotId =
                ctx.snapshotId().orElseThrow(() -> new IllegalStateException("no snapshot attached to the job"));
        ctx.updateProgress(15);
        DetectionContext detectionContext = detectionContextFactory.build(snapshotId, ctx.clonePath());
        List<DetectedArea> areas = engine.detect(detectionContext);
        ctx.updateProgress(50);
        transactionTemplate.executeWithoutResult(tx -> persist(ctx.projectId(), snapshotId, areas));
        ctx.updateProgress(100);
    }

    private void persist(long projectId, long snapshotId, List<DetectedArea> areas) {
        List<String> kept = new ArrayList<>();
        for (DetectedArea area : areas) {
            long areaId = jdbc.sql("""
                            insert into project_areas (snapshot_id, area_type, confidence, summary)
                            values (:snapshotId, :areaType, :confidence, null)
                            on conflict (snapshot_id, area_type) do update set confidence = excluded.confidence
                            returning id
                            """)
                    .param("snapshotId", snapshotId)
                    .param("areaType", area.areaType().name())
                    .param("confidence", area.confidence())
                    .query(Long.class)
                    .single();
            kept.add(area.areaType().name());
            jdbc.sql("delete from area_technologies where area_id = :areaId")
                    .param("areaId", areaId)
                    .update();
            for (String technology : area.technologies()) {
                jdbc.sql("""
                                insert into area_technologies (area_id, name)
                                values (:areaId, :name)
                                """).param("areaId", areaId).param("name", technology).update();
            }
            List<NewEvidence> evidences = area.signals().stream()
                    .map(signal -> new NewEvidence(
                            signal.evidenceRef().kind(),
                            signal.evidenceRef().filePath(),
                            signal.evidenceRef().line(),
                            signal.evidenceRef().line(),
                            signal.evidenceRef().excerpt()))
                    .toList();
            evidenceService.replaceLinked(projectId, EvidenceSubjects.PROJECT_AREA, areaId, evidences);
            if (area.confidence() >= AreaDetectionEngine.AUTO_SELECT_THRESHOLD) {
                jdbc.sql("""
                                insert into project_area_selections (project_id, area_type, selected)
                                values (:projectId, :areaType, true)
                                on conflict (project_id, area_type) do nothing
                                """)
                        .param("projectId", projectId)
                        .param("areaType", area.areaType().name())
                        .update();
            }
        }
        if (kept.isEmpty()) {
            jdbc.sql("delete from project_areas where snapshot_id = :snapshotId")
                    .param("snapshotId", snapshotId)
                    .update();
        } else {
            jdbc.sql("""
                            delete from project_areas
                            where snapshot_id = :snapshotId
                              and area_type not in (:kept)
                            """).param("snapshotId", snapshotId).param("kept", kept).update();
        }
    }
}
