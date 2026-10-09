package dev.codeintelligence.evidence;

import dev.codeintelligence.common.CustomPlans;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class EvidenceService {

    /** Rows per SQL VALUES batch or IN list. */
    private static final int BATCH = 500;

    private static final String INSERT_LINKED_ROWS = """
            with batch as materialized (
                select nextval(pg_get_serial_sequence('evidences', 'id')) as id,
                    cast(v.subject_id as bigint) as subject_id, v.kind, v.file_path,
                    cast(v.line_start as integer) as line_start, cast(v.line_end as integer) as line_end,
                    v.excerpt
                from (values :rows) as v(subject_id, kind, file_path, line_start, line_end, excerpt)
            ), inserted as (
                insert into evidences (id, project_id, kind, file_path, line_start, line_end, excerpt, created_by)
                select id, :projectId, kind, file_path, line_start, line_end, excerpt, 'STATIC' from batch
                returning id
            )
            insert into evidence_links (evidence_id, subject_type, subject_id)
            select inserted.id, :subjectType, batch.subject_id from inserted join batch using (id)
            """;

    private final JdbcClient jdbc;

    public EvidenceService(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Transactional
    public long insertStatic(long projectId, NewEvidence evidence) {
        return insert(projectId, evidence, "STATIC");
    }

    @Transactional
    public long insertAi(long projectId, NewEvidence evidence) {
        return insert(projectId, evidence, "AI");
    }

    private long insert(long projectId, NewEvidence evidence, String createdBy) {
        return jdbc.sql("""
                        insert into evidences (project_id, kind, file_path, line_start, line_end, excerpt, created_by)
                        values (:projectId, :kind, :filePath, :lineStart, :lineEnd, :excerpt, :createdBy)
                        returning id
                        """)
                .param("projectId", projectId)
                .param("kind", evidence.kind().name())
                .param("filePath", evidence.filePath())
                .param("lineStart", evidence.lineStart())
                .param("lineEnd", evidence.lineEnd())
                .param("excerpt", SecretMask.redact(evidence.excerpt()))
                .param("createdBy", createdBy)
                .query(Long.class)
                .single();
    }

    @Transactional
    public void link(long evidenceId, String subjectType, long subjectId) {
        jdbc.sql("""
                        insert into evidence_links (evidence_id, subject_type, subject_id)
                        values (:evidenceId, :subjectType, :subjectId)
                        on conflict (evidence_id, subject_type, subject_id) do nothing
                        """)
                .param("evidenceId", evidenceId)
                .param("subjectType", subjectType)
                .param("subjectId", subjectId)
                .update();
    }

    @Transactional
    public void deleteLinked(String subjectType, long subjectId) {
        jdbc.sql("""
                        delete from evidences e
                        where e.id in (
                            select el.evidence_id from evidence_links el
                            where el.subject_type = :subjectType and el.subject_id = :subjectId
                        )
                        """)
                .param("subjectType", subjectType)
                .param("subjectId", subjectId)
                .update();
    }

    @Transactional
    public void replaceLinked(long projectId, String subjectType, long subjectId, List<NewEvidence> evidences) {
        deleteLinked(subjectType, subjectId);
        for (NewEvidence evidence : evidences) {
            long id = insertStatic(projectId, evidence);
            link(id, subjectType, subjectId);
        }
    }

    /**
     * {@link #replaceLinked} for many subjects of one type with a few batched round trips: the
     * listed subjects' evidence is deleted, then each subject's list is inserted and linked.
     */
    @Transactional
    public void replaceLinkedAll(long projectId, String subjectType, Map<Long, List<NewEvidence>> bySubject) {
        List<Long> subjects = List.copyOf(bySubject.keySet());
        if (!subjects.isEmpty()) {
            // An empty-table generic plan can rescan all historical links for every subject batch.
            CustomPlans.run(jdbc, () -> {
                for (int start = 0; start < subjects.size(); start += BATCH) {
                    jdbc.sql("""
                                    delete from evidences e
                                    where e.id in (
                                        select el.evidence_id from evidence_links el
                                        where el.subject_type = :subjectType and el.subject_id in (:subjectIds)
                                    )
                                    """)
                            .param("subjectType", subjectType)
                            .param("subjectIds", subjects.subList(start, Math.min(start + BATCH, subjects.size())))
                            .update();
                }
                return null;
            });
        }
        List<Object[]> rows = new ArrayList<>(BATCH);
        for (Map.Entry<Long, List<NewEvidence>> entry : bySubject.entrySet()) {
            for (NewEvidence evidence : entry.getValue()) {
                rows.add(new Object[] {
                    entry.getKey(), evidence.kind().name(), evidence.filePath(),
                    evidence.lineStart(), evidence.lineEnd(), SecretMask.redact(evidence.excerpt())
                });
                if (rows.size() == BATCH) insertLinkedRows(projectId, subjectType, rows);
            }
        }
        insertLinkedRows(projectId, subjectType, rows);
    }

    private void insertLinkedRows(long projectId, String subjectType, List<Object[]> rows) {
        if (rows.isEmpty()) return;
        // The materialized CTE assigns each id once; duplicate facts need no RETURNING-order mapping.
        int inserted = jdbc.sql(INSERT_LINKED_ROWS)
                .param("projectId", projectId)
                .param("subjectType", subjectType)
                .param("rows", rows)
                .update();
        if (inserted != rows.size()) throw new IllegalStateException("evidence batch did not link every inserted row");
        rows.clear();
    }
}
