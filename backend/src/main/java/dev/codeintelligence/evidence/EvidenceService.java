package dev.codeintelligence.evidence;

import dev.codeintelligence.common.CustomPlans;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.core.namedparam.SqlParameterSource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class EvidenceService {

    /** Rows per JDBC batch or IN list. */
    private static final int BATCH = 500;

    private final JdbcClient jdbc;
    private final NamedParameterJdbcTemplate batches;

    public EvidenceService(JdbcClient jdbc, NamedParameterJdbcTemplate batches) {
        this.jdbc = jdbc;
        this.batches = batches;
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
        List<Long> owners = new ArrayList<>();
        List<SqlParameterSource> rows = new ArrayList<>();
        bySubject.forEach((subjectId, evidences) -> {
            for (NewEvidence evidence : evidences) {
                owners.add(subjectId);
                rows.add(new MapSqlParameterSource()
                        .addValue("projectId", projectId)
                        .addValue("kind", evidence.kind().name())
                        .addValue("filePath", evidence.filePath())
                        .addValue("lineStart", evidence.lineStart())
                        .addValue("lineEnd", evidence.lineEnd())
                        .addValue("excerpt", SecretMask.redact(evidence.excerpt()))
                        .addValue("createdBy", "STATIC"));
            }
        });
        for (int start = 0; start < rows.size(); start += BATCH) {
            int end = Math.min(start + BATCH, rows.size());
            GeneratedKeyHolder keys = new GeneratedKeyHolder();
            batches.batchUpdate(
                    """
                            insert into evidences (project_id, kind, file_path, line_start, line_end, excerpt, created_by)
                            values (:projectId, :kind, :filePath, :lineStart, :lineEnd, :excerpt, :createdBy)
                            """, rows.subList(start, end).toArray(SqlParameterSource[]::new), keys, new String[] {"id"});
            List<Map<String, Object>> ids = keys.getKeyList();
            if (ids.size() != end - start) {
                throw new IllegalStateException(
                        "evidence insert returned " + ids.size() + " ids for " + (end - start) + " rows");
            }
            SqlParameterSource[] links = new SqlParameterSource[ids.size()];
            for (int index = 0; index < ids.size(); index++) {
                links[index] = new MapSqlParameterSource()
                        .addValue("evidenceId", ((Number) ids.get(index).get("id")).longValue())
                        .addValue("subjectType", subjectType)
                        .addValue("subjectId", owners.get(start + index));
            }
            batches.batchUpdate("""
                    insert into evidence_links (evidence_id, subject_type, subject_id)
                    values (:evidenceId, :subjectType, :subjectId)
                    on conflict (evidence_id, subject_type, subject_id) do nothing
                    """, links);
        }
    }
}
