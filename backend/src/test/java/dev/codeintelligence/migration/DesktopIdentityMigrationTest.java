package dev.codeintelligence.migration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.DriverManager;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

@Testcontainers
class DesktopIdentityMigrationTest {
    @Container
    static final PostgreSQLContainer postgres = new PostgreSQLContainer(
            DockerImageName.parse("pgvector/pgvector:pg16").asCompatibleSubstituteFor("postgres"));

    @Test
    void upgradesExistingGithubAccountsAndProjectsFromV19ToDesktopIdentity() throws Exception {
        Flyway.configure()
                .dataSource(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())
                .target("19")
                .load()
                .migrate();
        try (var connection = DriverManager.getConnection(
                        postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
                var sql = connection.createStatement()) {
            sql.execute("insert into users(id, github_id, login) values (9001, 7001, 'migration-fixture')");
            sql.execute(
                    "insert into projects(id, user_id, name, repo_owner, repo_name) values (8001, 9001, 'fixture-project', 'fixture-owner', 'fixture-repo')");
        }
        var result = Flyway.configure()
                .dataSource(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())
                .target("20")
                .load()
                .migrate();
        assertThat(result.migrationsExecuted).isEqualTo(1);
        try (var connection = DriverManager.getConnection(
                        postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
                var sql = connection.createStatement()) {
            try (var rows = sql.executeQuery(
                    "select u.github_id, u.login, u.identity_type, u.local_key, p.name from users u join projects p on p.user_id = u.id where p.id = 8001")) {
                assertThat(rows.next()).isTrue();
                assertThat(rows.getLong("github_id")).isEqualTo(7001);
                assertThat(rows.getString("login")).isEqualTo("migration-fixture");
                assertThat(rows.getString("identity_type")).isEqualTo("GITHUB");
                assertThat(rows.getString("local_key")).isNull();
                assertThat(rows.getString("name")).isEqualTo("fixture-project");
            }
            sql.execute(
                    "insert into users(login, local_key, identity_type) values ('local-fixture', 'fixture-installation', 'LOCAL')");
            try (var rows = sql.executeQuery(
                    "select count(*) from users where github_id is null and local_key = 'fixture-installation'")) {
                rows.next();
                assertThat(rows.getInt(1)).isEqualTo(1);
            }
        }
        var cancellationUpgrade = Flyway.configure()
                .dataSource(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())
                .target("21")
                .load()
                .migrate();
        assertThat(cancellationUpgrade.migrationsExecuted).isEqualTo(1);
        try (var connection = DriverManager.getConnection(
                        postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
                var sql = connection.createStatement()) {
            sql.execute("insert into analysis_jobs(project_id, type, status) values (8001, 'IMPORT', 'CANCELLING')");
            assertThatThrownBy(() -> sql.execute(
                            "insert into analysis_jobs(project_id, type, status) values (8001, 'REANALYZE', 'QUEUED')"))
                    .isInstanceOf(java.sql.SQLException.class)
                    .satisfies(error -> assertThat(((java.sql.SQLException) error).getSQLState())
                            .isEqualTo("23505"));
            sql.execute("update analysis_jobs set status = 'CANCELLED' where project_id = 8001");
            sql.execute("insert into analysis_jobs(project_id, type, status) values (8001, 'REANALYZE', 'QUEUED')");
        }
        var approvalUpgrade = Flyway.configure()
                .dataSource(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())
                .target("22")
                .load()
                .migrate();
        assertThat(approvalUpgrade.migrationsExecuted).isEqualTo(1);
        try (var connection = DriverManager.getConnection(
                        postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
                var sql = connection.createStatement()) {
            try (var rows = sql.executeQuery("select u.github_id, u.login, p.name, j.failure_code "
                    + "from users u join projects p on p.user_id=u.id join analysis_jobs j on j.project_id=p.id "
                    + "where p.id=8001 and j.status='QUEUED'")) {
                assertThat(rows.next()).isTrue();
                assertThat(rows.getLong("github_id")).isEqualTo(7001);
                assertThat(rows.getString("login")).isEqualTo("migration-fixture");
                assertThat(rows.getString("name")).isEqualTo("fixture-project");
                assertThat(rows.getString("failure_code")).isNull();
            }
            try (var rows = sql.executeQuery("select (select count(*) from local_source_approvals) + "
                    + "(select count(*) from job_local_source_inputs) as implicit_authority")) {
                assertThat(rows.next()).isTrue();
                assertThat(rows.getInt(1)).isZero();
            }
        }
        try (var connection = connection();
                var sql = connection.createStatement()) {
            sql.execute(
                    "insert into snapshots(id,project_id,commit_sha,status) values (8002,8001,repeat('a',40),'READY')");
            sql.execute("update projects set current_snapshot_id=8002 where id=8001");
            sql.execute(
                    "insert into notes(id,project_id,title,content_md) values (8101,8001,'retention sentinel','keep original note')");
            sql.execute("insert into tasks(id,project_id,type,title,description,status,origin) "
                    + "values (8102,8001,'LEARNING','keep task','keep description','OPEN','USER')");
            sql.execute("insert into task_goals(task_id,seq,content,done) values (8102,1,'keep goal',true)");
        }
        String legacyBefore = legacyProjection();
        var sourceUpgrade = Flyway.configure()
                .dataSource(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())
                .target("23")
                .load()
                .migrate();
        assertThat(sourceUpgrade.migrationsExecuted).isEqualTo(1);
        assertThat(legacyProjection()).isEqualTo(legacyBefore);
        try (var connection = connection();
                var sql = connection.createStatement()) {
            try (var rows = sql.executeQuery("select current_generation_id from projects where id=8001")) {
                assertThat(rows.next()).isTrue();
                assertThat(rows.getObject(1)).isNull();
            }
            try (var rows = sql.executeQuery("select (select count(*) from source_blobs) + "
                    + "(select count(*) from source_manifests) + (select count(*) from analysis_generations)")) {
                assertThat(rows.next()).isTrue();
                assertThat(rows.getInt(1)).isZero();
            }
        }
        String credentialBefore;
        try (var connection = connection();
                var sql = connection.createStatement()) {
            sql.execute("""
                    insert into user_ai_settings (id,user_id,provider,model,encrypted_key,nonce,key_version)
                    values (8801,9001,'openai','gpt-4o-mini','opaque-legacy-credential',decode('001122','hex'),1)
                    """);
            try (var rows = sql.executeQuery("select to_jsonb(s)::text from user_ai_settings s where id=8801")) {
                assertThat(rows.next()).isTrue();
                credentialBefore = rows.getString(1);
            }
        }
        var preferenceUpgrade = Flyway.configure()
                .dataSource(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())
                .target("24")
                .load()
                .migrate();
        assertThat(preferenceUpgrade.migrationsExecuted).isEqualTo(1);
        assertThat(legacyProjection()).isEqualTo(legacyBefore);
        try (var connection = connection();
                var sql = connection.createStatement()) {
            try (var rows = sql.executeQuery("select to_jsonb(s)::text from user_ai_settings s where id=8801")) {
                assertThat(rows.next()).isTrue();
                assertThat(rows.getString(1)).isEqualTo(credentialBefore);
            }
            try (var rows = sql.executeQuery("select * from user_ai_preferences")) {
                assertThat(rows.next()).isTrue();
                assertThat(rows.getLong("user_id")).isEqualTo(9001);
                assertThat(rows.getString("provider")).isEqualTo("openai");
                assertThat(rows.getString("model")).isEqualTo("gpt-4o-mini");
                assertThat(rows.getString("connection_state")).isEqualTo("ENABLED");
                assertThat(rows.getLong("revision")).isZero();
                assertThat(rows.next()).isFalse();
            }
        }
    }

    private java.sql.Connection connection() throws java.sql.SQLException {
        return DriverManager.getConnection(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
    }

    private String legacyProjection() throws java.sql.SQLException {
        try (var connection = connection();
                var sql = connection.createStatement();
                var rows = sql.executeQuery("""
                select jsonb_build_object(
                  'user',(select to_jsonb(u) from users u where id=9001),
                  'project',(select to_jsonb(p)-'current_generation_id' from projects p where id=8001),
                  'snapshot',(select to_jsonb(s)-'source_contract_version' from snapshots s where id=8002),
                  'note',(select to_jsonb(n) from notes n where id=8101),
                  'task',(select to_jsonb(t) from tasks t where id=8102),
                  'goals',(select jsonb_agg(to_jsonb(g) order by id) from task_goals g where task_id=8102))
                """)) {
            assertThat(rows.next()).isTrue();
            return rows.getString(1);
        }
    }
}
