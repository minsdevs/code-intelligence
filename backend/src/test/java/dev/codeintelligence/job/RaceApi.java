package dev.codeintelligence.job;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.testsupport.FakeGithubApi;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseCookie;
import org.springframework.test.web.servlet.client.EntityExchangeResult;
import org.springframework.test.web.servlet.client.RestTestClient;
import tools.jackson.databind.json.JsonMapper;

/** The public HTTP job surface (session + CSRF) used by the race tests; mirrors the UI calls. */
final class RaceApi {

    record Created(long projectId, long jobId) {}

    private final RestTestClient client;
    private final JsonMapper json;
    private final ResponseCookie session;

    RaceApi(RestTestClient client, JsonMapper json) {
        this.client = client;
        this.json = json;
        this.session = login();
    }

    Created createProject(String owner, String name) {
        Map<String, Object> body =
                read(post("/api/projects", Map.of("repoOwner", owner, "repoName", name), HttpStatus.CREATED));
        @SuppressWarnings("unchecked")
        Map<String, Object> project = (Map<String, Object>) body.get("project");
        return new Created(((Number) project.get("id")).longValue(), ((Number) body.get("jobId")).longValue());
    }

    long reanalyze(long projectId) {
        return ((Number) read(post("/api/projects/" + projectId + "/reanalyze", null, HttpStatus.ACCEPTED))
                        .get("jobId"))
                .longValue();
    }

    void reanalyzeRejected(long projectId) {
        post("/api/projects/" + projectId + "/reanalyze", null, HttpStatus.CONFLICT);
    }

    void cancel(long jobId, HttpStatus expected) {
        post("/api/jobs/" + jobId + "/cancel", null, expected);
    }

    void retry(long jobId, HttpStatus expected) {
        post("/api/jobs/" + jobId + "/retry", null, expected);
    }

    void delete(long projectId, HttpStatus expected) {
        ResponseCookie csrf = csrf();
        client.delete()
                .uri("/api/projects/" + projectId)
                .cookie("SESSION", session.getValue())
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue())
                .exchange()
                .expectStatus()
                .isEqualTo(expected);
    }

    String sessionValue() {
        return session.getValue();
    }

    Map<String, Object> job(long jobId) {
        return read(client.get()
                .uri("/api/jobs/" + jobId)
                .cookie("SESSION", session.getValue())
                .exchange()
                .expectStatus()
                .isOk()
                .expectBody()
                .returnResult()
                .getResponseBodyContent());
    }

    private byte[] post(String uri, Object body, HttpStatus expected) {
        ResponseCookie csrf = csrf();
        RestTestClient.RequestBodySpec request = client.post()
                .uri(uri)
                .cookie("SESSION", session.getValue())
                .cookie("XSRF-TOKEN", csrf.getValue())
                .header("X-XSRF-TOKEN", csrf.getValue());
        RestTestClient.RequestHeadersSpec<?> ready = body == null
                ? request
                : request.contentType(MediaType.APPLICATION_JSON).body(body);
        return ready.exchange()
                .expectStatus()
                .isEqualTo(expected)
                .expectBody()
                .returnResult()
                .getResponseBodyContent();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> read(byte[] body) {
        return json.readValue(body, Map.class);
    }

    private ResponseCookie csrf() {
        EntityExchangeResult<byte[]> result = client.get()
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

    private ResponseCookie login() {
        ResponseCookie csrf = csrf();
        EntityExchangeResult<byte[]> result = client.post()
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
        ResponseCookie value = result.getResponseCookies().getFirst("SESSION");
        assertThat(value).isNotNull();
        return value;
    }
}
