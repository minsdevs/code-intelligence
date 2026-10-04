package dev.codeintelligence.analysis.graph;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.core.*;
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

    @Autowired
    private GraphPersistenceService persistence;

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
        getAs(session, "/api/projects/" + projectId + "/graph/overview", HttpStatus.NOT_FOUND);
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
        assertThat(((Number) d1.getFirst().get("sourceNodeId")).longValue()).isEqualTo(seeded.a());
        assertThat(((Number) d1.getFirst().get("targetNodeId")).longValue()).isEqualTo(seeded.b());
        assertThat(((Number) depth1.get("resolvedSnapshotId")).longValue()).isEqualTo(seeded.snapshotId());
        assertThat(depth1.get("truncated")).isEqualTo(false);

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
        assertThat(((Number) d2.get(1).get("sourceNodeId")).longValue()).isEqualTo(seeded.b());
        assertThat(((Number) d2.get(1).get("targetNodeId")).longValue()).isEqualTo(seeded.c());
        Map<String, Object> inbound = jsonMapper.readValue(
                getAs(
                        session,
                        "/api/projects/" + seeded.projectId() + "/graph/nodes/" + seeded.c()
                                + "/relations?direction=in&edgeType=CALLS&depth=2",
                        HttpStatus.OK),
                Map.class);
        List<Map<String, Object>> incoming = (List<Map<String, Object>>) inbound.get("relations");
        assertThat(((Number) incoming.getFirst().get("sourceNodeId")).longValue())
                .isEqualTo(seeded.b());
        assertThat(((Number) incoming.getFirst().get("targetNodeId")).longValue())
                .isEqualTo(seeded.c());

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

    @Test
    void explicitSnapshotSurvivesCurrentResultChangeAndCrossSnapshotEdgesAreExcluded() throws Exception {
        ResponseCookie session = loginWithPat();
        Seeded seeded = seedChain();
        long next = jdbcTemplate.queryForObject("""
                insert into snapshots (project_id, commit_sha, status, analyzed_at)
                values (?, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'READY', now()) returning id
                """, Long.class, seeded.projectId());
        long replacement = insertMethod(next, "java:demo.A#a()", "New A");
        insertCall(seeded.snapshotId(), seeded.a(), replacement);
        jdbcTemplate.update("update projects set current_snapshot_id = ? where id = ?", next, seeded.projectId());
        String base = "/api/projects/" + seeded.projectId() + "/graph";
        Map<String, Object> old = jsonMapper.readValue(
                getAs(session, base + "/nodes/" + seeded.a() + "?snapshotId=" + seeded.snapshotId(), HttpStatus.OK),
                Map.class);
        assertThat(old.get("name")).isEqualTo("A");
        assertThat(((Number) old.get("resolvedSnapshotId")).longValue()).isEqualTo(seeded.snapshotId());
        getAs(session, base + "/nodes/" + seeded.a(), HttpStatus.NOT_FOUND);
        Map<String, Object> relations = jsonMapper.readValue(
                getAs(
                        session,
                        base + "/nodes/" + seeded.a() + "/relations?snapshotId=" + seeded.snapshotId(),
                        HttpStatus.OK),
                Map.class);
        assertThat((List<?>) relations.get("relations")).hasSize(1);
        Map<String, Object> overview = jsonMapper.readValue(
                getAs(session, base + "/overview?snapshotId=" + seeded.snapshotId(), HttpStatus.OK), Map.class);
        assertThat(((Number) ((Map<?, ?>) overview.get("nodeCounts")).get("METHOD")).intValue())
                .isEqualTo(3);
        assertThat(((Number) ((Map<?, ?>) overview.get("edgeCounts")).get("CALLS")).intValue())
                .isEqualTo(2);
    }

    @Test
    void nodeCategoriesSearchSortAndPaginationStaySnapshotScoped() throws Exception {
        ResponseCookie session = loginWithPat();
        Seeded seeded = seedChain();
        jdbcTemplate.update("""
                insert into graph_nodes (snapshot_id, node_type, natural_key, name, metadata) values
                (?, 'CONFIG', 'dep:npm:react@package.json', 'react', '{}'),
                (?, 'PACKAGE', 'java:react', 'react', '{}'),
                (?, 'API_ENDPOINT', 'endpoint:GET:/items', 'GET /items', '{}')
                """, seeded.snapshotId(), seeded.snapshotId(), seeded.snapshotId());
        String base = "/api/projects/" + seeded.projectId() + "/graph/nodes";
        Map<String, Object> dependencies = jsonMapper.readValue(
                getAs(session, base + "?category=dependencies&sort=name", HttpStatus.OK), Map.class);
        assertThat(((Number) dependencies.get("total")).intValue()).isEqualTo(1);
        Map<String, Object> symbols = jsonMapper.readValue(
                getAs(session, base + "?category=symbols&sort=type&size=1&page=2", HttpStatus.OK), Map.class);
        assertThat(((Number) symbols.get("total")).intValue()).isEqualTo(3);
        List<Map<String, Object>> items = (List<Map<String, Object>>) symbols.get("items");
        assertThat(items).hasSize(1);
        assertThat(items.getFirst().get("name")).isEqualTo("B");
        Map<String, Object> hugePage =
                jsonMapper.readValue(getAs(session, base + "?page=2147483647&size=100", HttpStatus.OK), Map.class);
        assertThat((List<?>) hugePage.get("items")).isEmpty();
        getAs(session, base + "?sort=unsupported", HttpStatus.BAD_REQUEST);
        getAs(session, base + "?category=unsupported", HttpStatus.BAD_REQUEST);
    }

    @Test
    void largeNeighborhoodReportsTruncation() throws Exception {
        ResponseCookie session = loginWithPat();
        Seeded seeded = seedChain();
        jdbcTemplate.update("""
                insert into graph_nodes (snapshot_id, node_type, natural_key, name, metadata)
                select ?, 'METHOD', 'fan:' || x, 'Fan ' || x, '{}'::jsonb from generate_series(1, 510) x
                """, seeded.snapshotId());
        jdbcTemplate.update("""
                insert into graph_edges (snapshot_id, source_node_id, target_node_id, edge_type, confidence, metadata)
                select ?, ?, id, 'CALLS', 'CONFIRMED', '{}'::jsonb from graph_nodes
                where snapshot_id = ? and natural_key like 'fan:%'
                """, seeded.snapshotId(), seeded.a(), seeded.snapshotId());
        Map<String, Object> result = jsonMapper.readValue(
                getAs(
                        session,
                        "/api/projects/" + seeded.projectId() + "/graph/nodes/" + seeded.a() + "/relations",
                        HttpStatus.OK),
                Map.class);
        assertThat((List<?>) result.get("relations")).hasSize(GraphService.MAX_RELATIONS);
        assertThat(result.get("truncated")).isEqualTo(true);
    }

    @Test
    void laterAnalyzerCannotOverwriteEndpointSourceFromAnotherModule() throws Exception {
        ResponseCookie session = loginWithPat();
        Seeded seeded = seedChain();
        for (String path : List.of("one/Controller.java", "two/controller.ts")) {
            jdbcTemplate.update(
                    "insert into files(snapshot_id,path,language,size,content_hash) values (?,?,'java',1,'x')",
                    seeded.snapshotId(),
                    path);
        }
        GraphNodeDraft first = GraphNodeDraft.of(
                GraphNodeType.API_ENDPOINT, "endpoint:GET:/items", "GET /items", "one/Controller.java", 1, 2);
        GraphNodeDraft second = GraphNodeDraft.of(
                GraphNodeType.API_ENDPOINT, "endpoint:GET:/items", "GET /items", "two/controller.ts", 1, 2);
        var link = GraphEdgeDraft.of(
                "java:demo.A#a()", first.naturalKey(), GraphEdgeType.EXPOSES, EdgeConfidence.CONFIRMED);
        persistence.persist(
                seeded.projectId(), seeded.snapshotId(), new AnalysisResult(List.of(first), List.of(link), List.of()));
        persistence.persist(
                seeded.projectId(), seeded.snapshotId(), new AnalysisResult(List.of(second), List.of(link), List.of()));
        Map<String, Object> stored = jdbcTemplate.queryForMap(
                "select node_type,file_id,line_start from graph_nodes where snapshot_id=? and natural_key=?",
                seeded.snapshotId(),
                first.naturalKey());
        assertThat(stored.get("node_type")).isEqualTo("AMBIGUOUS");
        assertThat(stored.get("file_id")).isNull();
        assertThat(stored.get("line_start")).isNull();
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from graph_edges where snapshot_id=? and edge_type='EXPOSES'",
                        Long.class,
                        seeded.snapshotId()))
                .isZero();
        assertThat(jdbcTemplate.queryForList(
                        "select analysis_reason from files where snapshot_id=?", String.class, seeded.snapshotId()))
                .containsOnly("AMBIGUOUS_SYMBOL_IDENTITY");
        Map<String, Object> overview = jsonMapper.readValue(
                getAs(session, "/api/projects/" + seeded.projectId() + "/graph/overview", HttpStatus.OK), Map.class);
        assertThat(((Map<?, ?>) overview.get("nodeCounts")).containsKey("AMBIGUOUS"))
                .isFalse();
        Map<String, Object> endpoints = jsonMapper.readValue(
                getAs(
                        session,
                        "/api/projects/" + seeded.projectId() + "/graph/nodes?category=entrypoints",
                        HttpStatus.OK),
                Map.class);
        assertThat(((Number) endpoints.get("total")).longValue()).isZero();
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
        return new Seeded(projectId, snapshotId, a, b, c);
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

    private record Seeded(long projectId, long snapshotId, long a, long b, long c) {}
}
