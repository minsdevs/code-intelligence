package dev.codeintelligence.evidence;

import java.util.List;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class EvidenceService {

    private final JdbcClient jdbc;

    public EvidenceService(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Transactional
    public long insertStatic(long projectId, NewEvidence evidence) {
        return jdbc.sql("""
                        insert into evidences (project_id, kind, file_path, line_start, line_end, excerpt, created_by)
                        values (:projectId, :kind, :filePath, :lineStart, :lineEnd, :excerpt, 'STATIC')
                        returning id
                        """)
                .param("projectId", projectId)
                .param("kind", evidence.kind().name())
                .param("filePath", evidence.filePath())
                .param("lineStart", evidence.lineStart())
                .param("lineEnd", evidence.lineEnd())
                .param("excerpt", SecretMask.redact(evidence.excerpt()))
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
}
