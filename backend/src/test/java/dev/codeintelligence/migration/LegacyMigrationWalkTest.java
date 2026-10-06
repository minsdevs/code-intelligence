package dev.codeintelligence.migration;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;
import tools.jackson.databind.json.JsonMapper;

/**
 * G-EVIDENCE legacy migration: walks every Flyway step from V1 to the current version, one version
 * at a time. User sentinel rows are written as soon as their table exists and every earlier
 * sentinel projection must still be contained in its row after every later step. Historical
 * results end as explicitly unmeasured legacy data, never as recorded success.
 */
@Testcontainers
class LegacyMigrationWalkTest {
    @Container
    static final PostgreSQLContainer postgres = new PostgreSQLContainer(
            DockerImageName.parse("pgvector/pgvector:pg16").asCompatibleSubstituteFor("postgres"));

    /** Sentinel rows inserted when the named version is first applied. */
    private static final Map<Integer, List<String>> SENTINELS = Map.of(
            1,
            List.of(
                    "insert into users(id,github_id,login,name) values (9001,7001,'legacy-owner','Legacy Owner')",
                    "insert into projects(id,user_id,name,repo_owner,repo_name,default_branch) "
                            + "values (8001,9001,'legacy-project','fixture-owner','fixture-repo','main')",
                    "insert into snapshots(id,project_id,commit_sha,status,analyzed_at) "
                            + "values (8002,8001,repeat('a',40),'READY','2026-01-01T00:00:00Z')",
                    "update projects set current_snapshot_id=8002 where id=8001",
                    "insert into analysis_jobs(id,project_id,snapshot_id,type,status) values (8003,8001,8002,'IMPORT','DONE')"),
            4,
            List.of(
                    "insert into files(id,snapshot_id,path,language,size,line_count,content_hash) "
                            + "values (8004,8002,'src/Legacy.java','java',42,3,repeat('b',40))",
                    "insert into evidences(id,project_id,kind,file_path,line_start,line_end,excerpt,created_by) "
                            + "values (8005,8001,'FILE_LINE','src/Legacy.java',1,3,'class Legacy {}','STATIC')"),
            6,
            List.of("insert into graph_nodes(id,snapshot_id,node_type,natural_key,name,file_id,line_start,line_end) "
                    + "values (8006,8002,'CLASS','java:legacy.Legacy','Legacy',8004,1,3)"),
            11,
            List.of("insert into analysis_findings(id,snapshot_id,category,severity,title,detail,node_id) "
                    + "values (8007,8002,'DESIGN','MEDIUM','Legacy finding','keep finding detail',8006)"),
            13,
            List.of(
                    "insert into notes(id,project_id,title,content_md) values (8101,8001,'legacy note','keep note @file:src/Legacy.java')",
                    "insert into note_references(id,note_id,subject_type,subject_id,raw_target,label) "
                            + "values (8102,8101,'FILE',8004,'src/Legacy.java','src/Legacy.java')",
                    "insert into tasks(id,project_id,type,title,description,status,origin) "
                            + "values (8103,8001,'LEARNING','legacy task','keep task','OPEN','USER')",
                    "insert into task_goals(id,task_id,seq,content,done) values (8104,8103,1,'keep goal',true)"),
            15,
            List.of("insert into user_ai_settings(id,user_id,provider,encrypted_key,nonce,key_version) "
                    + "values (8105,9001,'openai','opaque-synthetic-ciphertext',decode('001122','hex'),1)"),
            19,
            List.of(
                    "insert into finding_judgments(id,user_id,project_id,stable_key,status,reason,rule_id,rule_version,"
                            + "evidence_fingerprint) values (8106,9001,8001,'legacy-key','ACCEPTED','keep judgment','rule','1','fp')"));

    private static final Map<String, String> PROJECTIONS = new LinkedHashMap<>();

    static {
        PROJECTIONS.put("user", "select to_jsonb(t) - 'updated_at' from users t where id=9001");
        PROJECTIONS.put("project", "select to_jsonb(t) - 'updated_at' from projects t where id=8001");
        PROJECTIONS.put("snapshot", "select to_jsonb(t) from snapshots t where id=8002");
        PROJECTIONS.put("job", "select to_jsonb(t) - 'updated_at' from analysis_jobs t where id=8003");
        PROJECTIONS.put("file", "select to_jsonb(t) from files t where id=8004");
        PROJECTIONS.put("evidence", "select to_jsonb(t) from evidences t where id=8005");
        PROJECTIONS.put("node", "select to_jsonb(t) from graph_nodes t where id=8006");
        PROJECTIONS.put("finding", "select to_jsonb(t) from analysis_findings t where id=8007");
        PROJECTIONS.put("note", "select to_jsonb(t) from notes t where id=8101");
        PROJECTIONS.put("noteReference", "select to_jsonb(t) from note_references t where id=8102");
        PROJECTIONS.put("task", "select to_jsonb(t) from tasks t where id=8103");
        PROJECTIONS.put("taskGoal", "select to_jsonb(t) from task_goals t where id=8104");
        PROJECTIONS.put("aiSetting", "select to_jsonb(t) from user_ai_settings t where id=8105");
        PROJECTIONS.put("findingJudgment", "select to_jsonb(t) from finding_judgments t where id=8106");
    }

    private static final Map<String, Integer> CREATED_AT = Map.ofEntries(
            Map.entry("user", 1),
            Map.entry("project", 1),
            Map.entry("snapshot", 1),
            Map.entry("job", 1),
            Map.entry("file", 4),
            Map.entry("evidence", 4),
            Map.entry("node", 6),
            Map.entry("finding", 11),
            Map.entry("note", 13),
            Map.entry("noteReference", 13),
            Map.entry("task", 13),
            Map.entry("taskGoal", 13),
            Map.entry("aiSetting", 15),
            Map.entry("findingJudgment", 19));

    @Test
    void everyFlywayStepPreservesSentinelsAndLegacyResultsStayUnmeasured() throws Exception {
        var all = Flyway.configure()
                .dataSource(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())
                .load()
                .info()
                .all();
        int latest = Integer.parseInt(all[all.length - 1].getVersion().getVersion());
        assertThat(latest).isGreaterThanOrEqualTo(27);
        Map<String, String> captured = new LinkedHashMap<>();
        List<Map<String, Object>> steps = new ArrayList<>();
        for (int version = 1; version <= latest; version++) {
            var result = Flyway.configure()
                    .dataSource(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())
                    .target(Integer.toString(version))
                    .load()
                    .migrate();
            assertThat(result.migrationsExecuted).as("V" + version).isEqualTo(1);
            try (Connection connection = connection();
                    var sql = connection.createStatement()) {
                for (String statement : SENTINELS.getOrDefault(version, List.of())) sql.execute(statement);
            }
            int checked = 0;
            for (var projection : PROJECTIONS.entrySet()) {
                if (CREATED_AT.get(projection.getKey()) > version) continue;
                String now = single(projection.getValue());
                assertThat(now)
                        .as(projection.getKey() + " row exists after V" + version)
                        .isNotNull();
                String before = captured.putIfAbsent(projection.getKey(), now);
                if (before != null) {
                    // Later migrations may add columns; every original column/value must survive unchanged.
                    assertThat(contains(now, before))
                            .as(projection.getKey() + " preserved through V" + version)
                            .isTrue();
                }
                checked++;
            }
            steps.add(Map.of("version", version, "sentinelsChecked", checked));
        }
        // Legacy results are explicit legacy/unmeasured data after the final step.
        assertThat(single("select analysis_status from files where id=8004")).isEqualTo("LEGACY_UNMEASURED");
        assertThat(single("select analysis_targeted::text from files where id=8004"))
                .isEqualTo("false");
        assertThat(single("select coalesce(analysis_reason,'<null>') from files where id=8004"))
                .isEqualTo("<null>");
        assertThat(single("select count(*)::text from snapshot_inventory_measurements"))
                .isEqualTo("0");
        assertThat(single("select source_contract_version::text from snapshots where id=8002"))
                .isEqualTo("0");
        assertThat(single("select coalesce(current_generation_id::text,'<null>') from projects where id=8001"))
                .isEqualTo("<null>");
        assertThat(single("select (select count(*) from source_manifests) + (select count(*) from analysis_generations)"
                        + " + (select count(*) from source_blobs)"))
                .isEqualTo("0");
        assertThat(single("select count(*)::text from flyway_schema_history where success is not true"))
                .isEqualTo("0");
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("format", 1);
        report.put("latestVersion", latest);
        report.put("steps", steps);
        report.put("sentinels", captured.keySet());
        report.put("legacyFileStatus", "LEGACY_UNMEASURED");
        Path file = Path.of("build", "reports", "legacy-migration-walk.json").toAbsolutePath();
        Files.createDirectories(file.getParent());
        Files.writeString(
                file, new JsonMapper().writerWithDefaultPrettyPrinter().writeValueAsString(report) + "\n");
    }

    private boolean contains(String current, String original) throws SQLException {
        try (Connection connection = connection();
                var statement = connection.prepareStatement("select ?::jsonb @> ?::jsonb")) {
            statement.setString(1, current);
            statement.setString(2, original);
            try (var rows = statement.executeQuery()) {
                rows.next();
                return rows.getBoolean(1);
            }
        }
    }

    private String single(String query) throws SQLException {
        try (Connection connection = connection();
                var sql = connection.createStatement();
                var rows = sql.executeQuery(query)) {
            return rows.next() ? rows.getString(1) : null;
        }
    }

    private Connection connection() throws SQLException {
        return DriverManager.getConnection(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
    }
}
