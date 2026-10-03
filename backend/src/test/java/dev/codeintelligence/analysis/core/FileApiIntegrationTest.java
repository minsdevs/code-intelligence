package dev.codeintelligence.analysis.core;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.testsupport.FakeGithubApi;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.Constants;
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
class FileApiIntegrationTest {

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
    void fileContentRejectsPathTraversal() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "readme.md", "hello\n");

        getAs(session, "/api/projects/" + projectId + "/file-content?path=../secret", HttpStatus.BAD_REQUEST);
        getAs(session, "/api/projects/" + projectId + "/file-content?path=/etc/passwd", HttpStatus.BAD_REQUEST);
        getAs(session, "/api/projects/" + projectId + "/file-content?path=%2e%2e%2fsecret", HttpStatus.BAD_REQUEST);
    }

    @Test
    void fileContentNeverFollowsWorkingTreeSymlinks() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "readme.md", "hello\n");
        Path clone = root.resolve("data").resolve("repos").resolve(String.valueOf(projectId));
        Path outside = root.resolve("outside-secret.txt");
        Files.writeString(outside, "leaked-token\n");
        Path link = clone.resolve("readme.md");
        Files.delete(link);
        try {
            Files.createSymbolicLink(link, outside);
        } catch (UnsupportedOperationException | IOException ignored) {
            return;
        }
        org.junit.jupiter.api.Assumptions.assumeTrue(Files.isSymbolicLink(link));
        Map<String, Object> body = jsonMapper.readValue(
                getAs(session, "/api/projects/" + projectId + "/file-content?path=readme.md", HttpStatus.OK),
                Map.class);
        assertThat(body.get("content")).isEqualTo("hello\n");
        assertThat(body.toString()).doesNotContain("leaked-token");
    }

    @Test
    void fileApisAreOwnerScoped() throws Exception {
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

        getAs(session, "/api/projects/" + projectId + "/files", HttpStatus.NOT_FOUND);
        getAs(session, "/api/projects/" + projectId + "/file-content?path=readme.md", HttpStatus.NOT_FOUND);
        getAs(session, "/api/projects/" + projectId + "/stats", HttpStatus.NOT_FOUND);
        getAs(session, "/api/projects/" + projectId + "/areas", HttpStatus.NOT_FOUND);
    }

    @Test
    void fileContentRejectsBinaryAndOversized() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "readme.md", "hello\n");
        Path clone = root.resolve("data").resolve("repos").resolve(String.valueOf(projectId));
        long snapshotId = jdbcTemplate.queryForObject(
                "select current_snapshot_id from projects where id = ?", Long.class, projectId);

        Files.write(clone.resolve("blob.bin"), new byte[] {1, 0, 2});
        jdbcTemplate.update("""
                insert into files (snapshot_id, path, language, size, line_count, content_hash)
                values (?, 'blob.bin', null, 3, null, ?)
                """, snapshotId, insertBlob(clone, new byte[] {1, 0, 2}));
        getAs(session, "/api/projects/" + projectId + "/file-content?path=blob.bin", HttpStatus.UNSUPPORTED_MEDIA_TYPE);

        byte[] huge = new byte[1_048_577];
        Files.write(clone.resolve("huge.txt"), huge);
        jdbcTemplate.update("""
                insert into files (snapshot_id, path, language, size, line_count, content_hash)
                values (?, 'huge.txt', null, ?, 1, ?)
                """, snapshotId, huge.length, insertBlob(clone, huge));
        getAs(session, "/api/projects/" + projectId + "/file-content?path=huge.txt", HttpStatus.CONTENT_TOO_LARGE);
    }

    @Test
    void listsFilesAndStatsAndTextContent() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "src/App.tsx", "export const x = 1;\n");

        byte[] filesBody = getAs(session, "/api/projects/" + projectId + "/files", HttpStatus.OK);
        List<Map<String, Object>> files = jsonMapper.readValue(filesBody, List.class);
        assertThat(files).extracting(row -> row.get("path")).containsExactly("src/App.tsx");
        assertThat(files.getFirst().get("language")).isEqualTo("typescript");

        Map<String, Object> content = jsonMapper.readValue(
                getAs(session, "/api/projects/" + projectId + "/file-content?path=src/App.tsx", HttpStatus.OK),
                Map.class);
        assertThat(content.get("path")).isEqualTo("src/App.tsx");
        assertThat(content.get("content")).isEqualTo("export const x = 1;\n");

        Map<String, Object> stats =
                jsonMapper.readValue(getAs(session, "/api/projects/" + projectId + "/stats", HttpStatus.OK), Map.class);
        assertThat(stats.get("fileCount")).isEqualTo(1);
    }

    @Test
    void putAreaSelectionsReturnsNoContent() throws Exception {
        ResponseCookie session = loginWithPat();
        long projectId = seedOwnedProject(session, "readme.md", "hello\n");
        ResponseCookie csrf = primeCsrfToken();
        restTestClient
                .put()
                .uri("/api/projects/" + projectId + "/area-selections")
                .contentType(MediaType.APPLICATION_JSON)
                .cookie("SESSION", session.getValue())
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue())
                .body(Map.of("selections", List.of(Map.of("areaType", "BACKEND", "selected", true))))
                .exchange()
                .expectStatus()
                .isNoContent();
        Boolean selected = jdbcTemplate.queryForObject("""
                select selected from project_area_selections
                where project_id = ? and area_type = 'BACKEND'
                """, Boolean.class, projectId);
        assertThat(selected).isTrue();
    }

    @Test
    void putAreaSelectionsIsOwnerScoped() throws Exception {
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
        ResponseCookie csrf = primeCsrfToken();
        restTestClient
                .put()
                .uri("/api/projects/" + projectId + "/area-selections")
                .contentType(MediaType.APPLICATION_JSON)
                .cookie("SESSION", session.getValue())
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue())
                .body(Map.of("selections", List.of(Map.of("areaType", "BACKEND", "selected", true))))
                .exchange()
                .expectStatus()
                .isNotFound();
        Integer rows = jdbcTemplate.queryForObject(
                "select count(*) from project_area_selections where project_id = ?", Integer.class, projectId);
        assertThat(rows).isZero();
    }

    private long seedOwnedProject(ResponseCookie session, String path, String content) throws Exception {
        long userId = jdbcTemplate.queryForObject("select id from users where login = 'octocat'", Long.class);
        long projectId = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'demo', 'octocat', ?) returning id
                """, Long.class, userId, "demo-" + System.nanoTime());
        Path clone = root.resolve("data").resolve("repos").resolve(String.valueOf(projectId));
        Path file = clone.resolve(path);
        Files.createDirectories(file.getParent());
        Files.writeString(file, content);
        Git.init().setDirectory(clone.toFile()).call().close();
        jdbcTemplate.update("update projects set clone_path = ? where id = ?", clone.toString(), projectId);
        long snapshotId = jdbcTemplate.queryForObject("""
                insert into snapshots (project_id, commit_sha, status, analyzed_at)
                values (?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'READY', now()) returning id
                """, Long.class, projectId);
        jdbcTemplate.update("update projects set current_snapshot_id = ? where id = ?", snapshotId, projectId);
        jdbcTemplate.update(
                """
                insert into files (snapshot_id, path, language, size, line_count, content_hash)
                values (?, ?, ?, ?, ?, ?)
                """,
                snapshotId,
                path,
                LanguageDetector.detect(path),
                content.getBytes(StandardCharsets.UTF_8).length,
                FileInventoryScanner.countLines(content.getBytes(StandardCharsets.UTF_8)),
                insertBlob(clone, content.getBytes(StandardCharsets.UTF_8)));
        return projectId;
    }

    private String insertBlob(Path clone, byte[] bytes) throws Exception {
        try (Git git = Git.open(clone.toFile());
                var insert = git.getRepository().newObjectInserter()) {
            String oid = insert.insert(Constants.OBJ_BLOB, bytes).name();
            insert.flush();
            return oid;
        }
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
