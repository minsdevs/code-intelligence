package dev.codeintelligence.history;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.common.Sleeper;
import dev.codeintelligence.github.GithubApiClient;
import dev.codeintelligence.github.GithubProperties;
import dev.codeintelligence.github.GithubPullRequestsPermissionException;
import dev.codeintelligence.github.GithubRateLimitException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.ExpectedCount;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

class PullRequestCollectorTest {

    private static final String BASE_URL = "https://api.github.test";
    private static final String PULLS_PAGE_1 = BASE_URL + "/repos/octocat/hello/pulls?state=all&per_page=100&page=1";
    private static final String PULLS_PAGE_2 = BASE_URL + "/repos/octocat/hello/pulls?state=all&per_page=100&page=2";

    @Test
    void rateLimitBackoffThenSucceeds() {
        RecordingSleeper sleeper = new RecordingSleeper();
        CollectorFixture fixture = collector(sleeper, 5);

        HttpHeaders limited = new HttpHeaders();
        limited.add("x-ratelimit-remaining", "0");
        fixture.server
                .expect(requestTo(PULLS_PAGE_1))
                .andExpect(method(HttpMethod.GET))
                .andRespond(withStatus(HttpStatus.FORBIDDEN)
                        .headers(limited)
                        .body("{\"message\":\"API rate limit exceeded\"}")
                        .contentType(MediaType.APPLICATION_JSON));
        HttpHeaders ok = new HttpHeaders();
        ok.add("ETag", "W/\"abc\"");
        fixture.server
                .expect(requestTo(PULLS_PAGE_1))
                .andExpect(method(HttpMethod.GET))
                .andRespond(withSuccess("[]", MediaType.APPLICATION_JSON).headers(ok));

        PullRequestCollector.PullsFetch fetch = fixture.collector.fetchAll("tok", "octocat", "hello", null);

        assertThat(fetch.notModified()).isFalse();
        assertThat(fetch.pulls()).isEmpty();
        assertThat(fetch.etag()).isEqualTo("W/\"abc\"");
        assertThat(sleeper.sleeps).containsExactly(Duration.ofSeconds(1));
        fixture.server.verify();
    }

    @Test
    void respectsRetryAfterHeader() {
        RecordingSleeper sleeper = new RecordingSleeper();
        CollectorFixture fixture = collector(sleeper, 5);

        HttpHeaders limited = new HttpHeaders();
        limited.add(HttpHeaders.RETRY_AFTER, "7");
        fixture.server
                .expect(requestTo(PULLS_PAGE_1))
                .andRespond(withStatus(HttpStatus.FORBIDDEN)
                        .headers(limited)
                        .body("{\"message\":\"secondary rate limit\"}")
                        .contentType(MediaType.APPLICATION_JSON));
        fixture.server.expect(requestTo(PULLS_PAGE_1)).andRespond(withSuccess("[]", MediaType.APPLICATION_JSON));

        fixture.collector.fetchAll("tok", "octocat", "hello", null);

        assertThat(sleeper.sleeps).containsExactly(Duration.ofSeconds(7));
        fixture.server.verify();
    }

    @Test
    void exceedingRetriesFailsTheStep() {
        RecordingSleeper sleeper = new RecordingSleeper();
        CollectorFixture fixture = collector(sleeper, 2);

        HttpHeaders limited = new HttpHeaders();
        limited.add("x-ratelimit-remaining", "0");
        fixture.server
                .expect(ExpectedCount.times(3), requestTo(PULLS_PAGE_1))
                .andRespond(withStatus(HttpStatus.FORBIDDEN)
                        .headers(limited)
                        .body("{\"message\":\"API rate limit exceeded\"}")
                        .contentType(MediaType.APPLICATION_JSON));

        assertThatThrownBy(() -> fixture.collector.fetchAll("tok", "octocat", "hello", null))
                .isInstanceOf(GithubRateLimitException.class);
        assertThat(sleeper.sleeps).containsExactly(Duration.ofSeconds(1), Duration.ofSeconds(2));
        fixture.server.verify();
    }

    @Test
    void etagNotModifiedSkipsFurtherFetches() {
        RecordingSleeper sleeper = new RecordingSleeper();
        CollectorFixture fixture = collector(sleeper, 5);

        fixture.server
                .expect(requestTo(PULLS_PAGE_1))
                .andExpect(header(HttpHeaders.IF_NONE_MATCH, "W/\"keep\""))
                .andRespond(withStatus(HttpStatus.NOT_MODIFIED));
        fixture.server.expect(ExpectedCount.never(), requestTo(PULLS_PAGE_2));

        PullRequestCollector.PullsFetch fetch = fixture.collector.fetchAll("tok", "octocat", "hello", "W/\"keep\"");

        assertThat(fetch.notModified()).isTrue();
        assertThat(fetch.pulls()).isEmpty();
        assertThat(sleeper.sleeps).isEmpty();
        fixture.server.verify();
    }

    @Test
    void mapsPullFieldsAndFollowsPagination() {
        RecordingSleeper sleeper = new RecordingSleeper();
        CollectorFixture fixture = collector(sleeper, 5);

        HttpHeaders page1 = new HttpHeaders();
        page1.add(HttpHeaders.LINK, "<" + PULLS_PAGE_2 + ">; rel=\"next\"");
        page1.add("ETag", "W/\"p1\"");
        fixture.server
                .expect(requestTo(PULLS_PAGE_1))
                .andRespond(withSuccess("""
                                [{"number":2,"title":"Two","body":"b2","state":"open",
                                  "user":{"login":"octocat"},"merged_at":null,
                                  "head":{"sha":"aaaa"},"base":{"sha":"bbbb"}}]""", MediaType.APPLICATION_JSON).headers(page1));
        fixture.server.expect(requestTo(PULLS_PAGE_2)).andRespond(withSuccess("""
                                [{"number":1,"title":"One","body":null,"state":"closed",
                                  "user":{"login":"hubot"},"merged_at":"2026-02-01T00:00:00Z",
                                  "head":{"sha":"cccc"},"base":{"sha":"dddd"}}]""", MediaType.APPLICATION_JSON));

        PullRequestCollector.PullsFetch fetch = fixture.collector.fetchAll("tok", "octocat", "hello", null);

        assertThat(fetch.notModified()).isFalse();
        assertThat(fetch.pulls()).hasSize(2);
        assertThat(fetch.pulls().get(0).number()).isEqualTo(2);
        assertThat(fetch.pulls().get(0).author()).isEqualTo("octocat");
        assertThat(fetch.pulls().get(1).number()).isEqualTo(1);
        assertThat(fetch.pulls().get(1).mergedAt()).isEqualTo(Instant.parse("2026-02-01T00:00:00Z"));
        fixture.server.verify();
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(
            strings = {"Resource not accessible by integration", "Resource not accessible by personal access token"})
    void explicitPermissionDenialIsOptionalAndNeverRetried(String message) {
        RecordingSleeper sleeper = new RecordingSleeper();
        CollectorFixture fixture = collector(sleeper, 2);
        fixture.server
                .expect(requestTo(PULLS_PAGE_1))
                .andRespond(withStatus(HttpStatus.FORBIDDEN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .body("{\"message\":\"" + message + "\"}"));
        assertThatThrownBy(() -> fixture.collector.fetchAll("tok", "octocat", "hello", "existing-etag"))
                .isInstanceOf(GithubPullRequestsPermissionException.class);
        assertThat(sleeper.sleeps).isEmpty();
        fixture.server.verify();
    }

    @Test
    void partialPaginationCannotPublishAnIncompletePullList() {
        CollectorFixture fixture = collector(new RecordingSleeper(), 0);
        fixture.server
                .expect(requestTo(PULLS_PAGE_1))
                .andRespond(withSuccess("[{\"number\":1}]", MediaType.APPLICATION_JSON)
                        .header(HttpHeaders.LINK, "<ignored>; rel=\"next\""));
        fixture.server
                .expect(requestTo(PULLS_PAGE_2))
                .andRespond(withStatus(HttpStatus.FORBIDDEN)
                        .body("{\"message\":\"Resource not accessible by integration\"}"));
        assertThatThrownBy(() -> fixture.collector.fetchAll("tok", "octocat", "hello", null))
                .isInstanceOf(GithubPullRequestsPermissionException.class);
        fixture.server.verify();
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(ints = {401, 403, 429})
    void authenticationGenericForbiddenAndRateLimitsRemainFatal(int status) {
        CollectorFixture fixture = collector(new RecordingSleeper(), 0);
        String message =
                status == 403 ? "Organization SSO authorization required" : "Resource not accessible by integration";
        fixture.server
                .expect(requestTo(PULLS_PAGE_1))
                .andRespond(withStatus(HttpStatus.valueOf(status)).body("{\"message\":\"" + message + "\"}"));
        assertThatThrownBy(() -> fixture.collector.fetchAll("tok", "octocat", "hello", null))
                .isNotInstanceOf(GithubPullRequestsPermissionException.class);
        fixture.server.verify();
    }

    @Test
    void transportFailureIsNeverOptional() {
        CollectorFixture fixture = collector(new RecordingSleeper(), 0);
        fixture.server
                .expect(requestTo(PULLS_PAGE_1))
                .andRespond(org.springframework.test.web.client.response.MockRestResponseCreators.withException(
                        new java.io.IOException("synthetic network failure")));
        assertThatThrownBy(() -> fixture.collector.fetchAll("tok", "octocat", "hello", null))
                .isInstanceOf(org.springframework.web.client.RestClientException.class)
                .isNotInstanceOf(GithubPullRequestsPermissionException.class);
    }

    private static CollectorFixture collector(Sleeper sleeper, int retries) {
        RestClient.Builder builder = RestClient.builder();
        MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
        GithubApiClient client = new GithubApiClient(builder, new GithubProperties(BASE_URL, "https://github.com"));
        AnalysisProperties properties = new AnalysisProperties(20_000, 1_048_576, 10_000, retries, 1000, 0.5);
        return new CollectorFixture(server, new PullRequestCollector(client, properties, sleeper));
    }

    private record CollectorFixture(MockRestServiceServer server, PullRequestCollector collector) {}

    private static final class RecordingSleeper implements Sleeper {
        private final List<Duration> sleeps = new ArrayList<>();

        @Override
        public void sleep(Duration duration) {
            sleeps.add(duration);
        }
    }
}
