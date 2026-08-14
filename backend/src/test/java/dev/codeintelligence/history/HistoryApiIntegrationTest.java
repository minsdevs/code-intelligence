package dev.codeintelligence.history;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.testsupport.FakeGithubApi;
import dev.codeintelligence.testsupport.GitMetadataFixtures;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.PersonIdent;
import org.eclipse.jgit.revwalk.RevCommit;
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
        properties = {"app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", "app.analysis.max-file-size=64"
        })
@AutoConfigureRestTestClient
@Import(TestcontainersConfiguration.class)
class HistoryApiIntegrationTest {

    private static final FakeGithubApi fakeGithub = new FakeGithubApi();
    private static final PersonIdent IDENT = new PersonIdent("fixture", "fixture@test.local");

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
    private GitMetadataStore gitMetadataStore;

    @Autowired
    private JsonMapper jsonMapper;

    @Test
    void missingShaReturns404() throws Exception {
        ResponseCookie session = loginWithPat();
        Seeded repo = seedGitProject(session, "readme.md", "hello\n");

        getAs(
                session,
                "/api/projects/" + repo.projectId() + "/commits/deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
                HttpStatus.NOT_FOUND);
    }

    @Test
    void diffRejectsPathTraversal() throws Exception {
        ResponseCookie session = loginWithPat();
        Seeded repo = seedGitProject(session, "readme.md", "hello\n");

        getAs(
                session,
                "/api/projects/" + repo.projectId() + "/commits/" + repo.sha() + "/diff?path=../secret",
                HttpStatus.BAD_REQUEST);
        getAs(
                session,
                "/api/projects/" + repo.projectId() + "/commits/" + repo.sha() + "/diff?path=%2e%2e%2fsecret",
                HttpStatus.BAD_REQUEST);
    }

    @Test
    void diffExceedingSizeLimitReturns413() throws Exception {
        ResponseCookie session = loginWithPat();
        Seeded repo = seedGitProject(session, "huge.txt", "x".repeat(65));

        getAs(
                session,
                "/api/projects/" + repo.projectId() + "/commits/" + repo.sha() + "/diff?path=huge.txt",
                HttpStatus.CONTENT_TOO_LARGE);
    }

    @Test
    void ownerScopeHidesOtherUsersHistory() throws Exception {
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

        getAs(session, "/api/projects/" + projectId + "/commits", HttpStatus.NOT_FOUND);
        getAs(session, "/api/projects/" + projectId + "/branches", HttpStatus.NOT_FOUND);
        getAs(session, "/api/projects/" + projectId + "/tags", HttpStatus.NOT_FOUND);
        getAs(session, "/api/projects/" + projectId + "/pulls", HttpStatus.NOT_FOUND);
    }

    @Test
    void listsCommitsBranchesTagsAndDiff() throws Exception {
        ResponseCookie session = loginWithPat();
        long userId = jdbcTemplate.queryForObject("select id from users where login = 'octocat'", Long.class);
        long projectId = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'demo', 'octocat', ?) returning id
                """, Long.class, userId, "hist-" + System.nanoTime());
        Path clone = root.resolve("data").resolve("repos").resolve(String.valueOf(projectId));
        GitMetadataFixtures.GoldenRepo golden = GitMetadataFixtures.createGolden(clone);
        jdbcTemplate.update("update projects set clone_path = ? where id = ?", clone.toString(), projectId);
        long snapshotId = jdbcTemplate.queryForObject("""
                insert into snapshots (project_id, commit_sha, status, analyzed_at)
                values (?, ?, 'READY', now()) returning id
                """, Long.class, projectId, golden.c5());
        jdbcTemplate.update("update projects set current_snapshot_id = ? where id = ?", snapshotId, projectId);
        gitMetadataStore.replaceCloneMetadata(projectId, new GitMetadataScanner().scan(clone, 10_000));
        jdbcTemplate.update("""
                insert into pull_requests (project_id, number, title, body, state, author, merged_at, head_sha, base_sha)
                values (?, 7, 'Ship it', 'plain', 'open', 'octocat', null, 'aaaa', 'bbbb')
                """, projectId);

        List<Map<String, Object>> commits = jsonMapper.readValue(
                getAs(session, "/api/projects/" + projectId + "/commits", HttpStatus.OK), List.class);
        assertThat(commits).hasSize(5);
        Map<String, Object> detail = jsonMapper.readValue(
                getAs(session, "/api/projects/" + projectId + "/commits/" + golden.c1(), HttpStatus.OK), Map.class);
        assertThat(detail.get("sha")).isEqualTo(golden.c1());
        Map<String, Object> diff = jsonMapper.readValue(
                getAs(
                        session,
                        "/api/projects/" + projectId + "/commits/" + golden.c1() + "/diff?path=README.md",
                        HttpStatus.OK),
                Map.class);
        assertThat(diff.get("changeType")).isEqualTo("ADD");
        assertThat(diff.get("oldContent")).isNull();
        assertThat(diff.get("newContent")).isEqualTo("line1\n");

        List<Map<String, Object>> branches = jsonMapper.readValue(
                getAs(session, "/api/projects/" + projectId + "/branches", HttpStatus.OK), List.class);
        assertThat(branches).extracting(row -> row.get("name")).containsExactly("main", "topic");
        List<Map<String, Object>> tags =
                jsonMapper.readValue(getAs(session, "/api/projects/" + projectId + "/tags", HttpStatus.OK), List.class);
        assertThat(tags).extracting(row -> row.get("name")).containsExactly("v1.0");
        List<Map<String, Object>> pulls = jsonMapper.readValue(
                getAs(session, "/api/projects/" + projectId + "/pulls?state=open", HttpStatus.OK), List.class);
        assertThat(pulls).hasSize(1);
        assertThat(pulls.getFirst().get("number")).isEqualTo(7);
    }

    private Seeded seedGitProject(ResponseCookie session, String path, String content) throws Exception {
        long userId = jdbcTemplate.queryForObject("select id from users where login = 'octocat'", Long.class);
        long projectId = jdbcTemplate.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, 'demo', 'octocat', ?) returning id
                """, Long.class, userId, "demo-" + System.nanoTime());
        Path clone = root.resolve("data").resolve("repos").resolve(String.valueOf(projectId));
        Files.createDirectories(clone);
        String sha;
        try (Git git =
                Git.init().setInitialBranch("main").setDirectory(clone.toFile()).call()) {
            Path file = clone.resolve(path);
            Files.createDirectories(file.getParent());
            Files.writeString(file, content);
            git.add().addFilepattern(path).call();
            RevCommit commit = git.commit()
                    .setMessage("seed")
                    .setAuthor(IDENT)
                    .setCommitter(IDENT)
                    .setSign(false)
                    .call();
            sha = commit.getName();
        }
        jdbcTemplate.update("update projects set clone_path = ? where id = ?", clone.toString(), projectId);
        long snapshotId = jdbcTemplate.queryForObject("""
                insert into snapshots (project_id, commit_sha, status, analyzed_at)
                values (?, ?, 'READY', now()) returning id
                """, Long.class, projectId, sha);
        jdbcTemplate.update("update projects set current_snapshot_id = ? where id = ?", snapshotId, projectId);
        jdbcTemplate.update("""
                insert into commits (project_id, sha, author, message, committed_at, additions, deletions)
                values (?, ?, 'fixture', 'seed', now(), 1, 0)
                """, projectId, sha);
        jdbcTemplate.update("""
                insert into commit_files (commit_id, path, change_type)
                select id, ?, 'ADD' from commits where project_id = ? and sha = ?
                """, path, projectId, sha);
        return new Seeded(projectId, sha);
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

    private record Seeded(long projectId, String sha) {}
}
