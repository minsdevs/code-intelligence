package dev.codeintelligence.note;

import dev.codeintelligence.evidence.SecretMask;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import java.util.List;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

@Service
public class NoteService {

    private static final int TITLE_MAX = 200;
    private static final int BODY_MAX = 100_000;

    public record NoteRefView(String subjectType, Long subjectId, String rawTarget, String label, String hrefHint) {}

    public record NoteView(long id, String title, String contentMd, String updatedAt, List<NoteRefView> references) {}

    public record NoteSummary(long id, String title, String updatedAt) {}

    public record UpsertNote(String title, String contentMd) {}

    private final ProjectRepository projectRepository;
    private final JdbcClient jdbc;

    public NoteService(ProjectRepository projectRepository, JdbcClient jdbc) {
        this.projectRepository = projectRepository;
        this.jdbc = jdbc;
    }

    @Transactional(readOnly = true)
    public List<NoteSummary> list(long projectId, long userId) {
        requireOwned(projectId, userId);
        return jdbc.sql("""
                        select id, title, updated_at::text as updated_at
                        from notes
                        where project_id = :projectId
                        order by updated_at desc, id desc
                        """)
                .param("projectId", projectId)
                .query((rs, rowNum) ->
                        new NoteSummary(rs.getLong("id"), rs.getString("title"), rs.getString("updated_at")))
                .list();
    }

    @Transactional(readOnly = true)
    public NoteView get(long projectId, long userId, long noteId) {
        requireOwned(projectId, userId);
        return load(projectId, noteId);
    }

    @Transactional
    public NoteView create(long projectId, long userId, UpsertNote body) {
        Project project = requireOwned(projectId, userId);
        String title = requireTitle(body == null ? null : body.title());
        String content = sanitizeBody(body == null ? null : body.contentMd());
        long id = jdbc.sql("""
                        insert into notes (project_id, title, content_md)
                        values (:projectId, :title, :content)
                        returning id
                        """)
                .param("projectId", projectId)
                .param("title", title)
                .param("content", content)
                .query(Long.class)
                .single();
        replaceRefs(project, id, content);
        return load(projectId, id);
    }

    @Transactional
    public NoteView update(long projectId, long userId, long noteId, UpsertNote body) {
        Project project = requireOwned(projectId, userId);
        requireExists(projectId, noteId);
        String title = requireTitle(body == null ? null : body.title());
        String content = sanitizeBody(body == null ? null : body.contentMd());
        jdbc.sql("""
                        update notes
                        set title = :title, content_md = :content, updated_at = now()
                        where id = :id and project_id = :projectId
                        """)
                .param("title", title)
                .param("content", content)
                .param("id", noteId)
                .param("projectId", projectId)
                .update();
        replaceRefs(project, noteId, content);
        return load(projectId, noteId);
    }

    @Transactional
    public void delete(long projectId, long userId, long noteId) {
        requireOwned(projectId, userId);
        int n = jdbc.sql("delete from notes where id = :id and project_id = :projectId")
                .param("id", noteId)
                .param("projectId", projectId)
                .update();
        if (n == 0) {
            throw new NoteNotFoundException();
        }
    }

    private NoteView load(long projectId, long noteId) {
        NoteView note = jdbc.sql("""
                        select id, title, content_md, updated_at::text as updated_at
                        from notes
                        where id = :id and project_id = :projectId
                        """)
                .param("id", noteId)
                .param("projectId", projectId)
                .query((rs, rowNum) -> new NoteView(
                        rs.getLong("id"),
                        rs.getString("title"),
                        rs.getString("content_md"),
                        rs.getString("updated_at"),
                        List.of()))
                .optional()
                .orElseThrow(NoteNotFoundException::new);
        List<NoteRefView> refs = jdbc.sql("""
                        select subject_type, subject_id, raw_target, label
                        from note_references
                        where note_id = :noteId
                        order by id
                        """)
                .param("noteId", noteId)
                .query((rs, rowNum) -> new NoteRefView(
                        rs.getString("subject_type"),
                        (Long) rs.getObject("subject_id"),
                        rs.getString("raw_target"),
                        rs.getString("label"),
                        rs.getString("subject_type")))
                .list();
        return new NoteView(note.id(), note.title(), note.contentMd(), note.updatedAt(), refs);
    }

    private void replaceRefs(Project project, long noteId, String content) {
        jdbc.sql("delete from note_references where note_id = :noteId")
                .param("noteId", noteId)
                .update();
        Long snapshotId = project.getCurrentSnapshotId();
        for (NoteReferenceParser.ParsedRef ref : NoteReferenceParser.parse(content)) {
            Long subjectId = resolve(project.getId(), snapshotId, noteId, ref);
            jdbc.sql("""
                            insert into note_references (note_id, subject_type, subject_id, raw_target, label)
                            values (:noteId, :type, :subjectId, :raw, :label)
                            """)
                    .param("noteId", noteId)
                    .param("type", ref.type().name())
                    .param("subjectId", subjectId)
                    .param("raw", ref.rawTarget())
                    .param("label", ref.label())
                    .update();
        }
    }

    private Long resolve(long projectId, Long snapshotId, long noteId, NoteReferenceParser.ParsedRef ref) {
        return switch (ref.type()) {
            case FILE ->
                snapshotId == null
                        ? null
                        : jdbc.sql("select id from files where snapshot_id = :snapshotId and path = :path limit 1")
                                .param("snapshotId", snapshotId)
                                .param("path", ref.rawTarget())
                                .query(Long.class)
                                .optional()
                                .orElse(null);
            case NODE ->
                snapshotId == null
                        ? null
                        : jdbc.sql("""
                                    select id from graph_nodes
                                    where snapshot_id = :snapshotId
                                      and (name = :name or name ilike :suffix)
                                    order by id
                                    limit 1
                                    """)
                                .param("snapshotId", snapshotId)
                                .param("name", ref.rawTarget())
                                .param("suffix", "%#" + ref.rawTarget())
                                .query(Long.class)
                                .optional()
                                .orElse(null);
            case COMMIT ->
                jdbc.sql("""
                            select id from commits
                            where project_id = :projectId and lower(sha) like :prefix
                            limit 1
                            """)
                        .param("projectId", projectId)
                        .param("prefix", ref.rawTarget().toLowerCase() + "%")
                        .query(Long.class)
                        .optional()
                        .orElse(null);
            case TASK ->
                jdbc.sql("select id from tasks where project_id = :projectId and id = :id")
                        .param("projectId", projectId)
                        .param("id", Long.parseLong(ref.rawTarget()))
                        .query(Long.class)
                        .optional()
                        .orElse(null);
            case NOTE ->
                jdbc.sql("""
                            select id from notes
                            where project_id = :projectId and title = :title and id <> :self
                            limit 1
                            """)
                        .param("projectId", projectId)
                        .param("title", ref.rawTarget())
                        .param("self", noteId)
                        .query(Long.class)
                        .optional()
                        .orElse(null);
        };
    }

    private void requireExists(long projectId, long noteId) {
        Boolean ok = jdbc.sql("select exists(select 1 from notes where id = :id and project_id = :projectId)")
                .param("id", noteId)
                .param("projectId", projectId)
                .query(Boolean.class)
                .single();
        if (!Boolean.TRUE.equals(ok)) {
            throw new NoteNotFoundException();
        }
    }

    private Project requireOwned(long projectId, long userId) {
        return projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
    }

    private static String requireTitle(String title) {
        if (!StringUtils.hasText(title) || title.strip().length() > TITLE_MAX) {
            throw new InvalidNoteException();
        }
        return title.strip();
    }

    private static String sanitizeBody(String content) {
        String body = content == null ? "" : content;
        if (body.length() > BODY_MAX) {
            throw new InvalidNoteException();
        }
        return SecretMask.redact(body);
    }
}
