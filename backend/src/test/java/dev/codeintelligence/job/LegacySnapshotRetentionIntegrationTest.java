package dev.codeintelligence.job;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.testsupport.TestJobContext;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Legacy-contract (v0, e.g. GitHub) snapshots beyond the retention window are pruned, except a snapshot whose file or
 * graph node a note pins (07 §4: note pins are never deleted automatically; G-EVIDENCE F-1).
 */
@SpringBootTest(
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            "app.snapshot-retention=2",
            "app.ts-analyzer.base-url=",
            "app.tree-analyzer.base-url=",
            "app.ai.provider=none",
            "app.ai.openai.api-key=",
            "app.ai.gemini.api-key=",
            "app.github.base-url=http://127.0.0.1:1",
            "logging.level.root=WARN"
        })
@Import(TestcontainersConfiguration.class)
class LegacySnapshotRetentionIntegrationTest {

    @TempDir
    Path root;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private FinalizeStep finalizeStep;

    @Test
    void notePinnedLegacySnapshotsSurvivePruningWhileUnpinnedOnesAreRemoved() {
        String unique = UUID.randomUUID().toString();
        long user = jdbc.queryForObject(
                "insert into users(login,identity_type,local_key) values (?, 'LOCAL', ?) returning id",
                Long.class,
                "retention-" + unique,
                unique);
        long project = jdbc.queryForObject(
                "insert into projects(user_id,name,repo_owner,repo_name) values (?, 'legacy', 'fixture', ?) returning id",
                Long.class,
                user,
                unique);
        List<Long> ids = new ArrayList<>();
        for (int index = 0; index < 6; index++) {
            ids.add(jdbc.queryForObject(
                    "insert into snapshots(project_id,commit_sha,status) values (?, ?, ?) returning id",
                    Long.class,
                    project,
                    String.valueOf(index).repeat(40),
                    index < 5 ? "READY" : "ANALYZING"));
        }
        long filePinned = ids.get(0);
        long nodePinned = ids.get(1);
        long unpinned = ids.get(2);
        long unresolvedPin = ids.get(3);
        long pinnedFile = file(filePinned, "Pinned.java");
        long pinnedNodeFile = file(nodePinned, "Node.java");
        long pinnedNode = jdbc.queryForObject(
                "insert into graph_nodes(snapshot_id,node_type,natural_key,name,file_id) "
                        + "values (?, 'CLASS', 'java:demo.Node', 'demo.Node', ?) returning id",
                Long.class,
                nodePinned,
                pinnedNodeFile);
        long unpinnedFile = file(unpinned, "Pinned.java");
        file(unresolvedPin, "Pinned.java");
        long note = jdbc.queryForObject(
                "insert into notes(project_id,title,content_md) values (?, 'pins', 'See @file:Pinned.java @class:Node') "
                        + "returning id",
                Long.class,
                project);
        reference(note, "FILE", pinnedFile, "Pinned.java");
        reference(note, "NODE", pinnedNode, "Node");
        reference(note, "FILE", null, "Missing.java");
        long job = jdbc.queryForObject(
                "insert into analysis_jobs(project_id,type,status,snapshot_id) values (?, 'REANALYZE', 'RUNNING', ?) "
                        + "returning id",
                Long.class,
                project,
                ids.getLast());
        jdbc.update(
                "insert into analysis_job_steps(job_id,step_key,seq,status) values (?, ?, 1, 'RUNNING')",
                job,
                FinalizeStep.KEY);

        finalizeStep.run(new TestJobContext(job, project, ids.getLast(), root));

        assertThat(exists("snapshots", filePinned))
                .as("snapshot pinned through a FILE reference")
                .isTrue();
        assertThat(exists("files", pinnedFile)).as("pinned file row").isTrue();
        assertThat(exists("snapshots", nodePinned))
                .as("snapshot pinned through a NODE reference")
                .isTrue();
        assertThat(exists("graph_nodes", pinnedNode)).as("pinned node row").isTrue();
        assertThat(exists("files", pinnedNodeFile))
                .as("file of the pinned node")
                .isTrue();
        assertThat(exists("snapshots", unpinned))
                .as("unpinned snapshot beyond retention")
                .isFalse();
        assertThat(exists("files", unpinnedFile)).isFalse();
        assertThat(exists("snapshots", unresolvedPin))
                .as("unresolved reference pins nothing")
                .isFalse();
        assertThat(exists("snapshots", ids.get(4)))
                .as("inside the retention window")
                .isTrue();
        assertThat(exists("snapshots", ids.get(5))).as("published snapshot").isTrue();
        assertThat(exists("notes", note)).isTrue();
        assertThat(jdbc.queryForObject(
                        "select count(*) from note_references where note_id=? and subject_id is not null",
                        Integer.class,
                        note))
                .isEqualTo(2);
    }

    private long file(long snapshot, String path) {
        return jdbc.queryForObject(
                "insert into files(snapshot_id,path,size,content_hash) values (?, ?, 1, ?) returning id",
                Long.class,
                snapshot,
                path,
                "a".repeat(40));
    }

    private void reference(long note, String type, Long subject, String raw) {
        jdbc.update(
                "insert into note_references(note_id,subject_type,subject_id,raw_target,label) values (?, ?, ?, ?, ?)",
                note,
                type,
                subject,
                raw,
                raw);
    }

    private boolean exists(String table, long id) {
        return jdbc.queryForObject("select count(*) from " + table + " where id=?", Integer.class, id) == 1;
    }
}
