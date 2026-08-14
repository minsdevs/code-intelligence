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
class ArchitectureApiIntegrationTest {

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
    void ownerScopeHidesOtherUsersEndpointsEntitiesArchitectureAndFeatures() throws Exception {
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
        getAs(session, "/api/projects/" + projectId + "/endpoints", HttpStatus.NOT_FOUND);
        getAs(session, "/api/projects/" + projectId + "/entities", HttpStatus.NOT_FOUND);
        getAs(session, "/api/projects/" + projectId + "/architecture?area=BACKEND", HttpStatus.NOT_FOUND);
        getAs(session, "/api/projects/" + projectId + "/features", HttpStatus.NOT_FOUND);
    }

    @Test
    void listsEndpointsEntitiesArchitectureAndFeatureDetail() throws Exception {
        ResponseCookie session = loginWithPat();
        long userId = jdbcTemplate.queryForObject("select id from users where login = 'octocat'", Long.class);
        long projectId = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'demo', 'octocat', ?) returning id
                """, Long.class, userId, "arch-" + System.nanoTime());
        long snapshotId = jdbcTemplate.queryForObject("""
                insert into snapshots (project_id, commit_sha, status, analyzed_at)
                values (?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'READY', now()) returning id
                """, Long.class, projectId);
        jdbcTemplate.update("update projects set current_snapshot_id = ? where id = ?", snapshotId, projectId);
        long fileId = jdbcTemplate.queryForObject("""
                insert into files (snapshot_id, path, language, size, line_count, content_hash)
                values (?, 'src/TodoController.java', 'java', 12, 4, 'abc') returning id
                """, Long.class, snapshotId);
        long controllerId =
                insertNode(snapshotId, fileId, "CLASS", "java:demo.TodoController", "TodoController", "CONTROLLER");
        long serviceId = insertNode(snapshotId, fileId, "CLASS", "java:demo.TodoService", "TodoService", "SERVICE");
        long methodC = insertNode(snapshotId, fileId, "METHOD", "java:demo.TodoController#list()", "list", null);
        long methodS = insertNode(snapshotId, fileId, "METHOD", "java:demo.TodoService#findAll()", "findAll", null);
        long endpointId = jdbcTemplate.queryForObject("""
                insert into graph_nodes (snapshot_id, node_type, natural_key, name, file_id, metadata)
                values (?, 'API_ENDPOINT', 'endpoint:GET:/todos', 'GET /todos', ?,
                        '{"httpMethod":"GET","path":"/todos","handlerKey":"java:demo.TodoController#list()"}'::jsonb)
                returning id
                """, Long.class, snapshotId, fileId);
        long entityNode = jdbcTemplate.queryForObject("""
                insert into graph_nodes (snapshot_id, node_type, natural_key, name, file_id, metadata)
                values (?, 'DB_ENTITY', 'entity:demo.Todo', 'Todo', ?,
                        '{"entityName":"Todo","tableName":"todos","source":"JPA"}'::jsonb)
                returning id
                """, Long.class, snapshotId, fileId);
        jdbcTemplate.update(
                """
                insert into graph_edges (snapshot_id, source_node_id, target_node_id, edge_type, confidence)
                values (?, ?, ?, 'DECLARES', 'CONFIRMED'), (?, ?, ?, 'DECLARES', 'CONFIRMED'),
                       (?, ?, ?, 'CALLS', 'CONFIRMED'), (?, ?, ?, 'EXPOSES', 'CONFIRMED')
                """,
                snapshotId,
                controllerId,
                methodC,
                snapshotId,
                serviceId,
                methodS,
                snapshotId,
                methodC,
                methodS,
                snapshotId,
                controllerId,
                endpointId);
        jdbcTemplate.update("""
                insert into api_endpoints (snapshot_id, node_id, http_method, path, handler_key)
                values (?, ?, 'GET', '/todos', 'java:demo.TodoController#list()')
                """, snapshotId, endpointId);
        jdbcTemplate.update("""
                insert into db_entities (snapshot_id, node_id, entity_name, table_name, source)
                values (?, ?, 'Todo', 'todos', 'JPA')
                """, snapshotId, entityNode);
        long featureId = jdbcTemplate.queryForObject("""
                insert into features (snapshot_id, name, detection, confidence)
                values (?, 'todos', 'STATIC', 1.0) returning id
                """, Long.class, snapshotId);
        jdbcTemplate.update("""
                insert into feature_links (feature_id, node_id, role) values (?, ?, 'API'), (?, ?, 'SERVICE')
                """, featureId, controllerId, featureId, serviceId);

        List<Map<String, Object>> endpoints = jsonMapper.readValue(
                getAs(session, "/api/projects/" + projectId + "/endpoints", HttpStatus.OK), List.class);
        assertThat(endpoints).hasSize(1);
        assertThat(endpoints.getFirst().get("httpMethod")).isEqualTo("GET");
        assertThat(endpoints.getFirst().get("path")).isEqualTo("/todos");

        List<Map<String, Object>> entities = jsonMapper.readValue(
                getAs(session, "/api/projects/" + projectId + "/entities", HttpStatus.OK), List.class);
        assertThat(entities.getFirst().get("entityName")).isEqualTo("Todo");
        assertThat(entities.getFirst().get("tableName")).isEqualTo("todos");

        Map<String, Object> architecture = jsonMapper.readValue(
                getAs(session, "/api/projects/" + projectId + "/architecture?area=BACKEND", HttpStatus.OK), Map.class);
        assertThat(architecture.get("area")).isEqualTo("BACKEND");
        List<Map<String, Object>> groups = castList(architecture.get("groups"));
        assertThat(groups.stream().map(group -> group.get("layer")).toList()).contains("CONTROLLER", "SERVICE");
        List<Map<String, Object>> edges = castList(architecture.get("edges"));
        assertThat(edges)
                .anyMatch(edge -> "CONTROLLER".equals(edge.get("sourceGroup"))
                        && "SERVICE".equals(edge.get("targetGroup"))
                        && ((Number) edge.get("count")).intValue() >= 1);

        getAs(session, "/api/projects/" + projectId + "/architecture?area=FRONTEND", HttpStatus.OK);

        List<Map<String, Object>> features = jsonMapper.readValue(
                getAs(session, "/api/projects/" + projectId + "/features", HttpStatus.OK), List.class);
        assertThat(features).hasSize(1);
        assertThat(features.getFirst().get("name")).isEqualTo("todos");

        Map<String, Object> detail = jsonMapper.readValue(
                getAs(session, "/api/projects/" + projectId + "/features/" + featureId, HttpStatus.OK), Map.class);
        List<Map<String, Object>> links = castList(detail.get("links"));
        assertThat(links).extracting(link -> link.get("name")).contains("TodoController", "TodoService");
    }

    private long insertNode(long snapshotId, long fileId, String type, String key, String name, String layer) {
        String metadata = layer == null ? "{}" : "{\"layer\":\"" + layer + "\"}";
        return jdbcTemplate.queryForObject("""
                insert into graph_nodes (snapshot_id, node_type, natural_key, name, file_id, metadata)
                values (?, ?, ?, ?, ?, cast(? as jsonb)) returning id
                """, Long.class, snapshotId, type, key, name, fileId, metadata);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> castList(Object value) {
        return (List<Map<String, Object>>) value;
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
}
