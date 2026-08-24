package dev.codeintelligence.export;

import dev.codeintelligence.analysis.coverage.CoverageReport;
import dev.codeintelligence.analysis.coverage.CoverageService;
import dev.codeintelligence.evidence.SecretMask;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.Snapshot;
import dev.codeintelligence.project.SnapshotRepository;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * Generates shareable analysis summaries in Markdown or JSON.
 * Never includes source code content or secrets — only metadata, names, paths, and internal links.
 */
@Service
public class ExportService {

    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm (z)");

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final CoverageService coverageService;
    private final JdbcClient jdbc;

    public ExportService(
            ProjectRepository projectRepository,
            SnapshotRepository snapshotRepository,
            CoverageService coverageService,
            JdbcClient jdbc) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.coverageService = coverageService;
        this.jdbc = jdbc;
    }

    public record ExportArea(String areaType, double confidence, String technologies) {}

    public record ExportFeature(long id, String name, String detection, double confidence) {}

    public record ExportFlow(long id, String name, String kind) {}

    public record ExportFinding(long id, String category, String severity, String title) {}

    public record ExportData(
            String projectName,
            String sourceType,
            String commitSha,
            String analyzedAt,
            long projectId,
            List<ExportArea> areas,
            List<ExportFeature> features,
            List<ExportFlow> flows,
            List<ExportFinding> findings,
            CoverageReport coverage) {}

    public ExportData buildExportData(long projectId, long userId) {
        Project project =
                projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
        Long snapshotId = project.getCurrentSnapshotId();
        if (snapshotId == null) {
            throw new dev.codeintelligence.analysis.core.SnapshotNotFoundException();
        }
        Snapshot snapshot = snapshotRepository
                .findByIdAndProjectId(snapshotId, project.getId())
                .orElseThrow(dev.codeintelligence.analysis.core.SnapshotNotFoundException::new);

        String analyzedAt = snapshot.getAnalyzedAt() != null
                ? DATE_FMT.format(snapshot.getAnalyzedAt().atZone(ZoneOffset.UTC))
                : "N/A";

        List<ExportArea> areas = jdbc.sql("""
                        select area_type, confidence, technologies
                        from areas
                        where snapshot_id = :snapshotId
                        order by confidence desc
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new ExportArea(
                        rs.getString("area_type"),
                        rs.getDouble("confidence"),
                        SecretMask.redact(rs.getString("technologies"))))
                .list();

        List<ExportFeature> features = jdbc.sql("""
                        select id, name, detection, confidence
                        from features
                        where snapshot_id = :snapshotId
                        order by confidence desc
                        limit 20
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new ExportFeature(
                        rs.getLong("id"),
                        SecretMask.redact(rs.getString("name")),
                        rs.getString("detection"),
                        rs.getDouble("confidence")))
                .list();

        List<ExportFlow> flows = jdbc.sql("""
                        select id, name, kind
                        from flows
                        where snapshot_id = :snapshotId
                        order by id
                        limit 10
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) ->
                        new ExportFlow(rs.getLong("id"), SecretMask.redact(rs.getString("name")), rs.getString("kind")))
                .list();

        List<ExportFinding> findings = jdbc.sql("""
                        select id, category, severity, title
                        from analysis_findings
                        where snapshot_id = :snapshotId
                          and severity in ('HIGH', 'CRITICAL')
                        order by
                          case severity when 'CRITICAL' then 0 when 'HIGH' then 1 end,
                          id
                        limit 20
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new ExportFinding(
                        rs.getLong("id"),
                        rs.getString("category"),
                        rs.getString("severity"),
                        SecretMask.redact(rs.getString("title"))))
                .list();

        CoverageReport coverage = coverageService.getReport(projectId, userId);

        return new ExportData(
                SecretMask.redact(project.getName()),
                project.getSourceType(),
                snapshot.getCommitSha(),
                analyzedAt,
                projectId,
                areas,
                features,
                flows,
                findings,
                coverage);
    }

    public String toMarkdown(ExportData data) {
        StringBuilder md = new StringBuilder();
        md.append("# ").append(data.projectName()).append(" — Analysis Summary\n\n");
        md.append("**Date:** ").append(data.analyzedAt()).append("\n");
        md.append("**Commit:** `").append(data.commitSha()).append("`\n");
        md.append("**Source:** ").append(data.sourceType()).append("\n\n");

        // Areas
        md.append("## Areas\n\n");
        md.append("| Area | Confidence | Technologies |\n");
        md.append("| --- | --- | --- |\n");
        for (var area : data.areas()) {
            md.append("| ")
                    .append(area.areaType())
                    .append(" | ")
                    .append(String.format("%.0f%%", area.confidence() * 100))
                    .append(" | ")
                    .append(area.technologies() != null ? area.technologies() : "—")
                    .append(" |\n");
        }
        md.append('\n');

        // Features
        md.append("## Key Features\n\n");
        if (data.features().isEmpty()) {
            md.append("_No features detected._\n\n");
        } else {
            for (var f : data.features()) {
                md.append("- **")
                        .append(f.name())
                        .append("** (")
                        .append(f.detection())
                        .append(", ");
                md.append(String.format("%.0f%%", f.confidence() * 100)).append(") ");
                md.append("[→ view](/projects/")
                        .append(data.projectId())
                        .append("/features/")
                        .append(f.id())
                        .append(")\n");
            }
            md.append('\n');
        }

        // Flows
        md.append("## Representative Flows\n\n");
        if (data.flows().isEmpty()) {
            md.append("_No flows detected._\n\n");
        } else {
            for (var f : data.flows()) {
                md.append("- **")
                        .append(f.name())
                        .append("** (")
                        .append(f.kind())
                        .append(") ");
                md.append("[→ view](/projects/")
                        .append(data.projectId())
                        .append("/flows/")
                        .append(f.id())
                        .append(")\n");
            }
            md.append('\n');
        }

        // Findings
        md.append("## Risk Findings\n\n");
        if (data.findings().isEmpty()) {
            md.append("_No high/critical findings._\n\n");
        } else {
            md.append("| Severity | Category | Title |\n");
            md.append("| --- | --- | --- |\n");
            for (var f : data.findings()) {
                md.append("| ").append(f.severity()).append(" | ");
                md.append(f.category()).append(" | ");
                md.append(f.title()).append(" |\n");
            }
            md.append('\n');
        }

        // Coverage
        md.append("## Coverage\n\n");
        var cov = data.coverage();
        if (cov != null) {
            var fc = cov.fileCoverage();
            md.append("- Files discovered: ").append(fc.discoveredFiles()).append('\n');
            md.append("- Files analyzed: ").append(fc.analyzedFiles()).append('\n');
            md.append("- Skipped (size): ").append(fc.skippedForSize()).append('\n');
            md.append("- Skipped (binary): ").append(fc.skippedBinary()).append('\n');
        }
        md.append('\n');

        md.append("---\n_Generated by Code Intelligence_\n");
        return md.toString();
    }

    public Map<String, Object> toJson(ExportData data) {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("projectName", data.projectName());
        json.put("sourceType", data.sourceType());
        json.put("commitSha", data.commitSha());
        json.put("analyzedAt", data.analyzedAt());
        json.put("projectId", data.projectId());
        json.put("areas", data.areas());
        json.put("features", data.features());
        json.put("flows", data.flows());
        json.put("findings", data.findings());
        json.put("coverage", data.coverage());

        // Internal links
        Map<String, String> links = new LinkedHashMap<>();
        links.put("features", "/projects/" + data.projectId() + "/features");
        links.put("flows", "/projects/" + data.projectId() + "/flows");
        links.put("analysis", "/projects/" + data.projectId() + "/analysis");
        links.put("code", "/projects/" + data.projectId() + "/code");
        json.put("_links", links);

        return json;
    }
}
