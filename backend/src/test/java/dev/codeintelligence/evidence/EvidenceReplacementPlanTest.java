package dev.codeintelligence.evidence;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.support.TransactionTemplate;

/** Re-analysis must not scan retained evidence against every key in a cached generic IN plan. */
@SpringBootTest(properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@Import(TestcontainersConfiguration.class)
class EvidenceReplacementPlanTest {
    @TempDir
    static Path dataDir;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> dataDir.toString());
    }

    @Autowired
    EvidenceService evidence;

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    TransactionTemplate transactions;

    @Test
    void replacementStaysBoundedAfterAnEmptySnapshotPreparedItsDeletePlan() {
        transactions.executeWithoutResult(tx -> {
            long project = project();
            // Deterministically exercise the plan choice observed on the reused production connection.
            jdbc.execute("set local plan_cache_mode = force_generic_plan");
            Map<Long, List<NewEvidence>> subjects = new LinkedHashMap<>();
            for (long id = 1_000_000; id < 1_040_000; id++) subjects.put(id, List.of());
            evidence.replaceLinkedAll(project, EvidenceSubjects.GRAPH_NODE, subjects);
            jdbc.update("""
                    with inserted as (
                      insert into evidences(project_id,kind,file_path,created_by)
                      select ?, 'FILE_LINE', 'retained/' || i || '.java', 'STATIC'
                      from generate_series(1,120000) i returning id
                    )
                    insert into evidence_links(evidence_id,subject_type,subject_id)
                    select id, 'GRAPH_NODE', row_number() over (order by id) from inserted
                    """, project);

            long started = System.nanoTime();
            evidence.replaceLinkedAll(project, EvidenceSubjects.GRAPH_NODE, subjects);
            long elapsedMs = (System.nanoTime() - started) / 1_000_000;
            assertThat(elapsedMs).as("replacement with retained evidence, ms").isLessThan(8_000);
            assertThat(jdbc.queryForObject("select count(*) from evidences where project_id=?", Integer.class, project))
                    .isEqualTo(120_000);
            assertThat(jdbc.queryForObject("select current_setting('plan_cache_mode')", String.class))
                    .isEqualTo("force_generic_plan");
            tx.setRollbackOnly();
        });
    }

    @Test
    void replacementAcrossBatchBoundaryPreservesUnselectedSubjectsAndProjects() {
        transactions.executeWithoutResult(tx -> {
            long project = project();
            long otherProject = project();
            Map<Long, List<NewEvidence>> old = new LinkedHashMap<>();
            Map<Long, List<NewEvidence>> replacement = new LinkedHashMap<>();
            Map<Long, String> expected = new LinkedHashMap<>();
            for (long id = 1; id <= 503; id++) {
                old.put(id, List.of(fact("old/" + id + ".java")));
                if (id % 5 == 0) replacement.put(id, List.of());
                else {
                    String path = "new/" + id + ".java";
                    replacement.put(id, List.of(fact(path)));
                    expected.put(id, path);
                }
            }
            evidence.replaceLinkedAll(project, EvidenceSubjects.GRAPH_NODE, old);
            long differentType = evidence.insertStatic(project, fact("keep/other-type.java"));
            evidence.link(differentType, EvidenceSubjects.SOURCE_PARSING, 1);
            long unselected = evidence.insertStatic(project, fact("keep/unselected.java"));
            evidence.link(unselected, EvidenceSubjects.GRAPH_NODE, 90_000);
            long outsideProject = evidence.insertStatic(otherProject, fact("keep/other-project.java"));
            evidence.link(outsideProject, EvidenceSubjects.GRAPH_NODE, 90_001);

            evidence.replaceLinkedAll(project, EvidenceSubjects.GRAPH_NODE, replacement);

            Map<Long, String> actual = new LinkedHashMap<>();
            jdbc.query(
                    """
                    select el.subject_id,e.file_path from evidences e join evidence_links el on el.evidence_id=e.id
                    where e.project_id=? and el.subject_type='GRAPH_NODE' and el.subject_id between 1 and 503
                    order by el.subject_id
                    """,
                    rs -> {
                        actual.put(rs.getLong("subject_id"), rs.getString("file_path"));
                    },
                    project);
            assertThat(actual).isEqualTo(expected);
            assertThat(jdbc.queryForObject(
                            "select count(*) from evidences where project_id=? and file_path like 'old/%'",
                            Integer.class, project))
                    .isZero();
            assertThat(jdbc.queryForList(
                            "select file_path from evidences where id in (?,?,?) order by file_path",
                            String.class,
                            differentType,
                            unselected,
                            outsideProject))
                    .containsExactly("keep/other-project.java", "keep/other-type.java", "keep/unselected.java");
            tx.setRollbackOnly();
        });
    }

    private long project() {
        long unique = System.nanoTime();
        long user = jdbc.queryForObject(
                "insert into users(github_id,login) values (?,?) returning id",
                Long.class,
                unique,
                "evidence-" + unique);
        return jdbc.queryForObject("""
                insert into projects(user_id,name,repo_owner,repo_name)
                values (?,'evidence-plan','acme',?) returning id
                """, Long.class, user, "evidence-" + unique);
    }

    private NewEvidence fact(String path) {
        return new NewEvidence(EvidenceKind.FILE_LINE, path, 1, 1, "class Example {}");
    }
}
