package dev.codeintelligence.search;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.testsupport.FakeGithubApi;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
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
class SearchApiIntegrationTest {

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
    void searchReturnsOwnedFileAndNoteHitsAndHidesDrafts() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject("src/App.java", "class App {}\n");
        jdbcTemplate.update(
                "insert into notes (project_id, title, content_md) values (?, 'Auth notes', 'login flow')", projectId);
        jdbcTemplate.update("""
                insert into tasks (project_id, type, title, description, status, origin)
                values (?, 'REVIEW', 'Hidden search draft', '', 'DRAFT', 'AI')
                """, projectId);
        jdbcTemplate.update("""
                insert into tasks (project_id, type, title, description, status, origin)
                values (?, 'DEVELOPMENT', 'Ship login', 'open the App file', 'OPEN', 'USER')
                """, projectId);

        jdbcTemplate.update("""
                insert into tasks (project_id, type, title, description, status, origin)
                values (?, 'LEARNING', 'Hidden archived learning', '', 'OPEN', 'USER')
                """, projectId);

        Map<String, Object> files = jsonMapper.readValue(
                getAs(session, "/api/search?q=App&projectId=" + projectId, HttpStatus.OK), Map.class);
        assertThat(groupTitles(files, "FILE")).contains("src/App.java");

        Map<String, Object> notes = jsonMapper.readValue(
                getAs(session, "/api/search?q=Auth&projectId=" + projectId, HttpStatus.OK), Map.class);
        assertThat(groupTitles(notes, "NOTE")).contains("Auth notes");

        Map<String, Object> tasks = jsonMapper.readValue(
                getAs(session, "/api/search?q=Hidden&projectId=" + projectId, HttpStatus.OK), Map.class);
        assertThat(groupTitles(tasks, "TASK")).doesNotContain("Hidden search draft", "Hidden archived learning");
        Map<String, Object> openTasks = jsonMapper.readValue(
                getAs(session, "/api/search?q=Ship&projectId=" + projectId, HttpStatus.OK), Map.class);
        assertThat(groupTitles(openTasks, "TASK")).contains("Ship login");
    }

    @Test
    void searchIsOwnerScopedAndRejectsBlankQuery() throws Exception {
        ResponseCookie session = loginWithPat();
        long otherUser = jdbcTemplate.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "other-" + System.nanoTime());
        long foreign = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'x', 'acme', 'x') returning id
                """, Long.class, otherUser);
        jdbcTemplate.update("insert into notes (project_id, title, content_md) values (?, 'Secret', 'nope')", foreign);
        Map<String, Object> body = jsonMapper.readValue(
                getAs(session, "/api/search?q=Secret&projectId=" + foreign, HttpStatus.OK), Map.class);
        assertThat((List<?>) body.get("groups")).isEmpty();
        restTestClient
                .get()
                .uri("/api/search?q={q}", "   ")
                .cookie("SESSION", session.getValue())
                .exchange()
                .expectStatus()
                .isBadRequest();
    }

    @SuppressWarnings("unchecked")
    private List<String> groupTitles(Map<String, Object> body, String type) {
        List<Map<String, Object>> groups = (List<Map<String, Object>>) body.get("groups");
        return groups.stream()
                .filter(group -> type.equals(group.get("type")))
                .flatMap(group -> ((List<Map<String, Object>>) group.get("hits")).stream())
                .map(hit -> (String) hit.get("title"))
                .toList();
    }

    private long seedOwnedProject(String path, String content) throws Exception {
        long userId = jdbcTemplate.queryForObject("select id from users where login = 'octocat'", Long.class);
        long projectId = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'demo', 'octocat', ?) returning id
                """, Long.class, userId, "demo-" + System.nanoTime());
        Path clone = root.resolve("data").resolve("repos").resolve(String.valueOf(projectId));
        Path file = clone.resolve(path);
        Files.createDirectories(file.getParent());
        Files.writeString(file, content);
        jdbcTemplate.update("update projects set clone_path = ? where id = ?", clone.toString(), projectId);
        long snapshotId = jdbcTemplate.queryForObject("""
                insert into snapshots (project_id, commit_sha, status, analyzed_at)
                values (?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'READY', now()) returning id
                """, Long.class, projectId);
        jdbcTemplate.update("update projects set current_snapshot_id = ? where id = ?", snapshotId, projectId);
        jdbcTemplate.update("""
                insert into files (snapshot_id, path, language, size, line_count, content_hash)
                values (?, ?, 'java', ?, 1, 'hash')
                """, snapshotId, path, content.getBytes(StandardCharsets.UTF_8).length);
        return projectId;
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
