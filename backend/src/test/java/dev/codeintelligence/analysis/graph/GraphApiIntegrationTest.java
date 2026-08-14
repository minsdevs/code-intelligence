package dev.codeintelligence.analysis.graph;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.testsupport.FakeGithubApi;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseCookie;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.EntityExchangeResult;
import org.springframework.test.web.servlet.client.RestTestClient;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@AutoConfigureRestTestClient
@Import(TestcontainersConfiguration.class)
class GraphApiIntegrationTest {

    private static final FakeGithubApi fakeGithub = new FakeGithubApi();

    @TempDir
    static Path root;

    @DynamicPropertySource
    static void testProperties(DynamicPropertyRegistry registry) {
        registry.add("app.github.base-url", fakeGithub::baseUrl);
        registry.add("app.data-dir", () -> root.resolve("data").toString());
    }

    @AfterAll
    static void stopFakeGithub() {
        fakeGithub.close();
    }

    @Autowired
    private RestTestClient restTestClient;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private JsonMapper jsonMapper;

    @Test
    void ownerScopeHidesOtherUsersGraph() throws Exception {
        ResponseCookie session = loginWithPat();
        long otherUser = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "other-" + System.nanoTime());
        long projectId = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'x', 'acme', 'x') returning id
                """, Long.class, otherUser);
        getAs(session, "/api/projects/" + projectId + "/graph/nodes", HttpStatus.NOT_FOUND);
    }

    @Test
    void relationsRespectDepthTwo() throws Exception {
        ResponseCookie session = loginWithPat();
        Seeded seeded = seedChain();
        Map<String, Object> depth1 = jsonMapper.readValue(
                getAs(
                        session,
                        "/api/projects/" + seeded.projectId() + "/graph/nodes/" + seeded.a()
                                + "/relations?direction=out&edgeType=CALLS&depth=1",
                        HttpStatus.OK),
                Map.class);
        List<Map<String, Object>> d1 = (List<Map<String, Object>>) depth1.get("relations");
        assertThat(d1).hasSize(1);
        assertThat(((Map<?, ?>) d1.getFirst().get("node")).get("name")).isEqualTo("B");
        assertThat(d1.getFirst().get("depth")).isEqualTo(1);

        Map<String, Object> depth2 = jsonMapper.readValue(
                getAs(
                        session,
                        "/api/projects/" + seeded.projectId() + "/graph/nodes/" + seeded.a()
                                + "/relations?direction=out&edgeType=CALLS&depth=2",
                        HttpStatus.OK),
                Map.class);
        List<Map<String, Object>> d2 = (List<Map<String, Object>>) depth2.get("relations");
        assertThat(d2.stream()
                        .map(row -> String.valueOf(((Map<?, ?>) row.get("node")).get("name")))
                        .toList())
                .containsExactly("B", "C");
        assertThat(d2.stream()
                        .map(row -> ((Number) row.get("depth")).intValue())
                        .toList())
                .containsExactly(1, 2);

        getAs(
                session,
                "/api/projects/" + seeded.projectId() + "/graph/nodes/" + seeded.a() + "/relations?depth=3",
                HttpStatus.BAD_REQUEST);

        Map<String, Object> page = jsonMapper.readValue(
                getAs(
                        session,
                        "/api/projects/" + seeded.projectId() + "/graph/nodes?type=METHOD&q=demo.A",
                        HttpStatus.OK),
                Map.class);
        assertThat(((Number) page.get("total")).intValue()).isEqualTo(1);
        Map<String, Object> detail = jsonMapper.readValue(
                getAs(session, "/api/projects/" + seeded.projectId() + "/graph/nodes/" + seeded.a(), HttpStatus.OK),
                Map.class);
        assertThat(detail.get("naturalKey")).isEqualTo("java:demo.A#a()");
    }

    private Seeded seedChain() {
        long userId = jdbcTemplate.queryForObject("select id from users where login = 'octocat'", Long.class);
        long projectId = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'demo', 'octocat', ?) returning id
                """, Long.class, userId, "graph-" + System.nanoTime());
        long snapshotId = jdbcTemplate.queryForObject("""
                insert into snapshots (project_id, commit_sha, status, analyzed_at)
                values (?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'READY', now()) returning id
                """, Long.class, projectId);
        jdbcTemplate.update("update projects set current_snapshot_id = ? where id = ?", snapshotId, projectId);
        long a = insertMethod(snapshotId, "java:demo.A#a()", "A");
        long b = insertMethod(snapshotId, "java:demo.B#b()", "B");
        long c = insertMethod(snapshotId, "java:demo.C#c()", "C");
        insertCall(snapshotId, a, b);
        insertCall(snapshotId, b, c);
        return new Seeded(projectId, a);
    }

    private long insertMethod(long snapshotId, String naturalKey, String name) {
        return jdbcTemplate.queryForObject("""
                insert into graph_nodes (snapshot_id, node_type, natural_key, name, metadata)
                values (?, 'METHOD', ?, ?, '{}'::jsonb) returning id
                """, Long.class, snapshotId, naturalKey, name);
    }

    private void insertCall(long snapshotId, long source, long target) {
        jdbcTemplate.update("""
                insert into graph_edges (snapshot_id, source_node_id, target_node_id, edge_type, confidence, metadata)
                values (?, ?, ?, 'CALLS', 'CONFIRMED', '{}'::jsonb)
                """, snapshotId, source, target);
    }

    private byte[] getAs(ResponseCookie session, String uri, HttpStatus expected) {
        return restTestClient
                .get()
                .uri(uri)
                .cookie("SESSION", session.getValue())
                .exchange()
                .expectStatus()
                .isEqualTo(expected)
                .expectBody()
                .returnResult()
                .getResponseBodyContent();
    }

    private ResponseCookie primeCsrfToken() {
        EntityExchangeResult<byte[]> result = restTestClient
                .get()
                .uri("/api/csrf")
                .exchange()
                .expectStatus()
                .isNoContent()
                .expectBody()
                .returnResult();
        ResponseCookie csrf = result.getResponseCookies().getFirst("XSRF-TOKEN");
        assertThat(csrf).isNotNull();
        return csrf;
    }

    private ResponseCookie loginWithPat() {
        ResponseCookie csrf = primeCsrfToken();
        EntityExchangeResult<byte[]> result = restTestClient
                .post()
                .uri("/api/auth/pat")
                .contentType(MediaType.APPLICATION_JSON)
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue())
                .body(Map.of("token", FakeGithubApi.VALID_TOKEN))
                .exchange()
                .expectStatus()
                .isNoContent()
                .expectBody()
                .returnResult();
        ResponseCookie session = result.getResponseCookies().getFirst("SESSION");
        assertThat(session).isNotNull();
        return session;
    }

    private record Seeded(long projectId, long a) {}
}
