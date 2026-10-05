package dev.codeintelligence;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.auth.TokenCryptoService;
import dev.codeintelligence.testsupport.FakeGithubApi;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseCookie;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.EntityExchangeResult;
import org.springframework.test.web.servlet.client.RestTestClient;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@AutoConfigureRestTestClient
@Import(TestcontainersConfiguration.class)
class AuthIntegrationTest {

    private static final String ALLOWED_ORIGIN = "http://localhost:5173";
    private static final FakeGithubApi fakeGithub = new FakeGithubApi();

    @DynamicPropertySource
    static void githubBaseUrl(DynamicPropertyRegistry registry) {
        registry.add("app.github.base-url", fakeGithub::baseUrl);
        registry.add("app.desktop.api-token", () -> "fixture-renderer-token");
        registry.add("app.desktop.path-token", () -> "fixture-main-only-token");
        registry.add("app.desktop.local-identity", () -> "fixture-desktop-identity");
        registry.add("app.desktop.allowed-origin", () -> ALLOWED_ORIGIN);
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
    private StringRedisTemplate redisTemplate;

    @Autowired
    private TokenCryptoService tokenCryptoService;

    @Test
    void folderGrantsRequireMainProcessCapability(@TempDir Path directory) throws Exception {
        Path folder = Files.createDirectory(directory.resolve("selected"));
        restTestClient
                .post()
                .uri("/api/desktop/paths")
                .header("X-Code-Intelligence-Token", "fixture-renderer-token")
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("path", folder.toString()))
                .exchange()
                .expectStatus()
                .isForbidden();
        restTestClient
                .post()
                .uri("/api/desktop/paths")
                .header("X-Code-Intelligence-Token", "fixture-renderer-token")
                .header("X-Code-Intelligence-Path-Token", "wrong-main-token")
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("path", folder.toString()))
                .exchange()
                .expectStatus()
                .isForbidden();
        restTestClient
                .post()
                .uri("/api/desktop/paths")
                .header("X-Code-Intelligence-Path-Token", "fixture-main-only-token")
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("path", folder.toString()))
                .exchange()
                .expectStatus()
                .isUnauthorized();
        restTestClient
                .post()
                .uri("/api/desktop/paths")
                .header("X-Code-Intelligence-Token", "fixture-renderer-token")
                .header("X-Code-Intelligence-Path-Token", "fixture-main-only-token")
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("path", folder.toString()))
                .exchange()
                .expectStatus()
                .isOk()
                .expectBody()
                .jsonPath("$.path")
                .isEqualTo(folder.toRealPath().toString());
    }

    @Test
    void bundledAssetsArePublicButProjectDataStillRequiresAuthentication() {
        restTestClient
                .get()
                .uri("/assets/audit-bootstrap.js")
                .exchange()
                .expectStatus()
                .isOk()
                .expectBody(String.class)
                .isEqualTo("/* test bootstrap asset */\n");
        restTestClient.get().uri("/api/projects").exchange().expectStatus().isUnauthorized();
    }

    @Test
    void meWithoutSessionReturns200AuthenticatedFalse() {
        restTestClient
                .get()
                .uri("/api/auth/me")
                .exchange()
                .expectStatus()
                .isOk()
                .expectBody()
                .jsonPath("$.authenticated")
                .isEqualTo(false)
                .jsonPath("$.oauthAvailable")
                .isEqualTo(false);
    }

    @Test
    void patRegistrationWithoutCsrfTokenIsForbidden() {
        restTestClient
                .post()
                .uri("/api/auth/pat")
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("token", FakeGithubApi.VALID_TOKEN))
                .exchange()
                .expectStatus()
                .isForbidden();
    }

    @Test
    void rejectedPatReturns401ProblemDetailWithoutEchoingToken() {
        ResponseCookie csrf = primeCsrfToken();
        EntityExchangeResult<byte[]> result = restTestClient
                .post()
                .uri("/api/auth/pat")
                .contentType(MediaType.APPLICATION_JSON)
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue())
                .body(Map.of("token", "ghp_wrong-secret"))
                .exchange()
                .expectStatus()
                .isUnauthorized()
                .expectHeader()
                .contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON)
                .expectBody()
                .returnResult();
        assertThat(new String(result.getResponseBodyContent(), StandardCharsets.UTF_8))
                .doesNotContain("ghp_wrong-secret");
    }

    @Test
    void patLoginCreatesRedisSessionAndStoresEncryptedCredential() {
        ResponseCookie session = loginWithPat();

        assertThat(session.isHttpOnly()).isTrue();
        assertThat(session.getSameSite()).isEqualTo("Lax");

        String sessionId = new String(Base64.getDecoder().decode(session.getValue()), StandardCharsets.UTF_8);
        assertThat(redisTemplate.keys("*")).contains("codeintel:session:sessions:" + sessionId);

        Integer userCount = jdbcTemplate.queryForObject(
                "select count(*) from users where github_id = ?", Integer.class, FakeGithubApi.USER_GITHUB_ID);
        assertThat(userCount).isEqualTo(1);

        Map<String, Object> credential = jdbcTemplate.queryForMap("""
                select c.kind, c.encrypted_token, c.nonce, c.key_version, c.scopes
                from github_credentials c join users u on u.id = c.user_id
                where u.github_id = ?
                """, FakeGithubApi.USER_GITHUB_ID);
        assertThat(credential.get("kind")).isEqualTo("PAT");
        assertThat(credential.get("key_version")).isEqualTo(1);
        assertThat(credential.get("scopes")).isEqualTo("repo, read:user");
        assertThat((String) credential.get("encrypted_token")).doesNotContain(FakeGithubApi.VALID_TOKEN);
        byte[] nonce = (byte[]) credential.get("nonce");
        assertThat(nonce).hasSize(12);
        assertThat(tokenCryptoService.decrypt(1, nonce, (String) credential.get("encrypted_token")))
                .isEqualTo(FakeGithubApi.VALID_TOKEN);
    }

    @Test
    void meAfterLoginReturnsProfileWithoutTokenMaterial() {
        ResponseCookie session = loginWithPat();

        EntityExchangeResult<byte[]> result = restTestClient
                .get()
                .uri("/api/auth/me")
                .cookie("SESSION", session.getValue())
                .exchange()
                .expectStatus()
                .isOk()
                .expectBody()
                .jsonPath("$.authenticated")
                .isEqualTo(true)
                .jsonPath("$.login")
                .isEqualTo("octocat")
                .jsonPath("$.name")
                .isEqualTo("Octo Cat")
                .jsonPath("$.credentialKind")
                .isEqualTo("PAT")
                .jsonPath("$.oauthAvailable")
                .isEqualTo(false)
                .returnResult();
        assertThat(new String(result.getResponseBodyContent(), StandardCharsets.UTF_8))
                .doesNotContain(FakeGithubApi.VALID_TOKEN);
    }

    @Test
    void reposWithoutSessionIsUnauthorized() {
        restTestClient.get().uri("/api/github/repos").exchange().expectStatus().isUnauthorized();
    }

    @Test
    void reposAfterLoginListsPrivateRepositories() {
        ResponseCookie session = loginWithPat();

        EntityExchangeResult<byte[]> result = restTestClient
                .get()
                .uri("/api/github/repos?page=1&perPage=30")
                .cookie("SESSION", session.getValue())
                .exchange()
                .expectStatus()
                .isOk()
                .expectBody()
                .jsonPath("$.items.length()")
                .isEqualTo(2)
                .jsonPath("$.items[0].fullName")
                .isEqualTo("octocat/alpha-service")
                .jsonPath("$.items[0].private")
                .isEqualTo(true)
                .jsonPath("$.items[0].owner")
                .isEqualTo("octocat")
                .jsonPath("$.items[0].defaultBranch")
                .isEqualTo("main")
                .jsonPath("$.page")
                .isEqualTo(1)
                .jsonPath("$.hasNext")
                .isEqualTo(true)
                .returnResult();
        assertThat(new String(result.getResponseBodyContent(), StandardCharsets.UTF_8))
                .doesNotContain(FakeGithubApi.VALID_TOKEN);
    }

    @Test
    void reposQueryParameterFiltersByName() {
        ResponseCookie session = loginWithPat();

        restTestClient
                .get()
                .uri("/api/github/repos?q=alpha")
                .cookie("SESSION", session.getValue())
                .exchange()
                .expectStatus()
                .isOk()
                .expectBody()
                .jsonPath("$.items.length()")
                .isEqualTo(1)
                .jsonPath("$.items[0].name")
                .isEqualTo("alpha-service");
    }

    @Test
    void corsPreflightAllowsOnlyConfiguredOrigins() {
        restTestClient
                .options()
                .uri("/api/auth/pat")
                .header(HttpHeaders.ORIGIN, ALLOWED_ORIGIN)
                .header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .exchange()
                .expectStatus()
                .isOk()
                .expectHeader()
                .valueEquals(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, ALLOWED_ORIGIN)
                .expectHeader()
                .valueEquals(HttpHeaders.ACCESS_CONTROL_ALLOW_CREDENTIALS, "true");

        restTestClient
                .options()
                .uri("/api/auth/pat")
                .header(HttpHeaders.ORIGIN, "https://evil.example")
                .header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .exchange()
                .expectStatus()
                .isForbidden();
    }

    @Test
    void logoutInvalidatesRedisSession() {
        ResponseCookie session = loginWithPat();
        ResponseCookie csrf = primeCsrfToken();
        String sessionKey = "codeintel:session:sessions:"
                + new String(Base64.getDecoder().decode(session.getValue()), StandardCharsets.UTF_8);
        assertThat(redisTemplate.keys("*")).contains(sessionKey);

        restTestClient
                .post()
                .uri("/api/auth/logout")
                .cookie("SESSION", session.getValue())
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue())
                .exchange()
                .expectStatus()
                .isNoContent();

        assertThat(redisTemplate.keys("*")).doesNotContain(sessionKey);

        restTestClient
                .get()
                .uri("/api/auth/me")
                .cookie("SESSION", session.getValue())
                .exchange()
                .expectStatus()
                .isOk()
                .expectBody()
                .jsonPath("$.authenticated")
                .isEqualTo(false);
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
        assertThat(csrf.isHttpOnly()).isFalse();
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
        assertThat(new String(result.getResponseBodyContent(), StandardCharsets.UTF_8))
                .doesNotContain(FakeGithubApi.VALID_TOKEN);
        ResponseCookie session = result.getResponseCookies().getFirst("SESSION");
        assertThat(session).isNotNull();
        return session;
    }
}
