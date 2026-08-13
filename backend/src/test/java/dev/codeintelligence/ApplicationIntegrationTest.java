package dev.codeintelligence;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.client.RestTestClient;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@AutoConfigureRestTestClient
@Import(TestcontainersConfiguration.class)
class ApplicationIntegrationTest {

    @Autowired
    private RestTestClient restTestClient;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void flywayCreatesCoreSchema() {
        Integer coreTables = jdbcTemplate.queryForObject("""
                select count(*) from information_schema.tables
                where table_schema = 'public'
                  and table_name in ('users', 'github_credentials', 'projects', 'snapshots',
                                     'project_area_selections', 'analysis_jobs', 'analysis_job_steps')
                """, Integer.class);
        assertThat(coreTables).isEqualTo(7);

        Boolean migrationSucceeded = jdbcTemplate.queryForObject(
                "select success from flyway_schema_history where version = '1'", Boolean.class);
        assertThat(migrationSucceeded).isTrue();

        Integer vectorExtension = jdbcTemplate.queryForObject(
                "select count(*) from pg_extension where extname = 'vector'", Integer.class);
        assertThat(vectorExtension).isEqualTo(1);
    }

    @Test
    void actuatorHealthIsUp() {
        restTestClient
                .get()
                .uri("/actuator/health")
                .exchange()
                .expectStatus()
                .isOk()
                .expectBody(String.class)
                .value(body -> assertThat(body).contains("\"status\":\"UP\""));
    }

    @Test
    void otherEndpointsRequireAuthentication() {
        restTestClient.get().uri("/api/anything").exchange().expectStatus().isUnauthorized();
    }

    @Test
    void openApiSpecIsServedForFrontendCodegen() {
        restTestClient
                .get()
                .uri("/v3/api-docs")
                .exchange()
                .expectStatus()
                .isOk()
                .expectBody(String.class)
                .value(body -> assertThat(body).contains("/api/auth/me").contains("/api/github/repos"));
    }
}
