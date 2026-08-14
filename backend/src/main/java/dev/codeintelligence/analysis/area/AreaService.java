package dev.codeintelligence.analysis.area;

import dev.codeintelligence.analysis.core.SnapshotNotFoundException;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.SnapshotRepository;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AreaService {

    public record AreaEvidenceView(String filePath, Integer line, String excerpt) {}

    public record AreaView(
            AreaType areaType,
            double confidence,
            List<String> technologies,
            List<AreaEvidenceView> evidences,
            boolean selected) {}

    public record AreaSelection(AreaType areaType, boolean selected) {}

    public record AreaSelectionsRequest(List<AreaSelection> selections) {}

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final JdbcClient jdbc;

    public AreaService(ProjectRepository projectRepository, SnapshotRepository snapshotRepository, JdbcClient jdbc) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.jdbc = jdbc;
    }

    @Transactional(readOnly = true)
    public List<AreaView> listAreas(long projectId, long userId, Long snapshotId) {
        Project project = requireOwned(projectId, userId);
        long resolved = requireSnapshot(project, snapshotId);
        Map<Long, AreaView> byId = new LinkedHashMap<>();
        jdbc.sql("""
                        select a.id, a.area_type, a.confidence, coalesce(s.selected, false) as selected
                        from project_areas a
                        left join project_area_selections s
                          on s.project_id = :projectId and s.area_type = a.area_type
                        where a.snapshot_id = :snapshotId
                        order by a.area_type
                        """)
                .param("projectId", projectId)
                .param("snapshotId", resolved)
                .query((rs, rowNum) -> {
                    long id = rs.getLong("id");
                    byId.put(
                            id,
                            new AreaView(
                                    AreaType.valueOf(rs.getString("area_type")),
                                    rs.getDouble("confidence"),
                                    new ArrayList<>(),
                                    new ArrayList<>(),
                                    rs.getBoolean("selected")));
                    return id;
                })
                .list();
        if (byId.isEmpty()) {
            return List.of();
        }
        jdbc.sql("""
                        select area_id, name from area_technologies
                        where area_id in (:ids) order by name
                        """)
                .param("ids", byId.keySet())
                .query((rs, rowNum) -> {
                    AreaView view = byId.get(rs.getLong("area_id"));
                    if (view != null) {
                        view.technologies().add(rs.getString("name"));
                    }
                    return 0;
                })
                .list();
        jdbc.sql("""
                        select el.subject_id, e.file_path, e.line_start, e.excerpt
                        from evidence_links el
                        join evidences e on e.id = el.evidence_id
                        where el.subject_type = 'PROJECT_AREA' and el.subject_id in (:ids)
                        order by e.id
                        """)
                .param("ids", byId.keySet())
                .query((rs, rowNum) -> {
                    AreaView view = byId.get(rs.getLong("subject_id"));
                    if (view != null) {
                        view.evidences()
                                .add(new AreaEvidenceView(
                                        rs.getString("file_path"),
                                        (Integer) rs.getObject("line_start"),
                                        rs.getString("excerpt")));
                    }
                    return 0;
                })
                .list();
        return List.copyOf(byId.values());
    }

    @Transactional
    public void updateSelections(long projectId, long userId, AreaSelectionsRequest request) {
        requireOwned(projectId, userId);
        if (request == null || request.selections() == null) {
            throw new InvalidAreaTypeException();
        }
        for (AreaSelection selection : request.selections()) {
            if (selection == null || selection.areaType() == null) {
                throw new InvalidAreaTypeException();
            }
            jdbc.sql("""
                            insert into project_area_selections (project_id, area_type, selected, updated_at)
                            values (:projectId, :areaType, :selected, now())
                            on conflict (project_id, area_type) do update
                              set selected = excluded.selected, updated_at = now()
                            """)
                    .param("projectId", projectId)
                    .param("areaType", selection.areaType().name())
                    .param("selected", selection.selected())
                    .update();
        }
    }

    private Project requireOwned(long projectId, long userId) {
        return projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
    }

    private long requireSnapshot(Project project, Long snapshotId) {
        Long id = snapshotId != null ? snapshotId : project.getCurrentSnapshotId();
        if (id == null) {
            throw new SnapshotNotFoundException();
        }
        snapshotRepository.findByIdAndProjectId(id, project.getId()).orElseThrow(SnapshotNotFoundException::new);
        return id;
    }
}
