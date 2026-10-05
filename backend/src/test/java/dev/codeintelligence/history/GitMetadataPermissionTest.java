package dev.codeintelligence.history;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import dev.codeintelligence.auth.GithubConnectionCoordinator;
import dev.codeintelligence.auth.GithubCredentialStore;
import dev.codeintelligence.auth.GithubCredentialStore.StoredCredential;
import dev.codeintelligence.auth.GithubDeviceCredentialCodec;
import dev.codeintelligence.auth.GithubNativeOAuthProperties;
import dev.codeintelligence.auth.GithubReauthenticationRequiredException;
import dev.codeintelligence.auth.GithubTokenLifecycle;
import dev.codeintelligence.auth.TokenCryptoService;
import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.common.Sleeper;
import dev.codeintelligence.common.security.CredentialKind;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.evidence.EvidenceSubjects;
import dev.codeintelligence.evidence.NewEvidence;
import dev.codeintelligence.github.GithubApiClient;
import dev.codeintelligence.github.GithubProperties;
import dev.codeintelligence.github.GithubPullRequestsPermissionException;
import dev.codeintelligence.github.GithubPullSummary;
import dev.codeintelligence.github.GithubRateLimitException;
import dev.codeintelligence.github.GithubTokenProvider;
import dev.codeintelligence.github.InvalidGithubTokenException;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.testsupport.TestJobContext;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.test.web.client.ResponseCreator;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

class GitMetadataPermissionTest {
    private final GitMetadataScanner scanner = mock(GitMetadataScanner.class);
    private final GitMetadataStore store = mock(GitMetadataStore.class);
    private final PullRequestCollector pulls = mock(PullRequestCollector.class);
    private final ProjectRepository projects = mock(ProjectRepository.class);
    private final GithubTokenProvider tokens = mock(GithubTokenProvider.class);
    private final EvidenceService evidence = mock(EvidenceService.class);
    private final Project project = mock(Project.class);
    private final TestJobContext context = new TestJobContext(1, 2, 3L, Path.of("/synthetic/not-read"));
    private final GitMetadataStep step = new GitMetadataStep(
            scanner,
            store,
            pulls,
            projects,
            tokens,
            new AnalysisProperties(20000, 1048576, 10000, 0, 1000, 0.5),
            evidence);

    private void fixture() throws Exception {
        when(projects.findById(2L)).thenReturn(Optional.of(project));
        when(project.getId()).thenReturn(2L);
        when(project.getUserId()).thenReturn(4L);
        when(project.getSourceType()).thenReturn("GITHUB");
        when(project.getRepoOwner()).thenReturn("synthetic");
        when(project.getRepoName()).thenReturn("fixture");
        when(tokens.findCredential(4L))
                .thenReturn(Optional.of(
                        new GithubTokenProvider.BorrowedToken("synthetic-token", () -> {}, () -> {}, Runnable::run)));
        when(store.findPullsEtag(2L)).thenReturn(Optional.of("preserved-etag"));
        when(scanner.scan(context.clonePath(), 10000))
                .thenReturn(new GitMetadataScan(List.of(), List.of(), List.of(), 7));
    }

    @Test
    void optionalPrPermissionPreservesRowsEtagAndCombinesWarningsWhileCompletingStep() throws Exception {
        fixture();
        when(pulls.fetchAll(anyString(), anyString(), anyString(), anyString(), any(Runnable.class)))
                .thenThrow(new GithubPullRequestsPermissionException());
        step.run(context);
        assertThat(context.progress()).isEqualTo(100);
        verify(store).replaceCloneMetadata(eq(2L), any());
        verify(store, never()).upsertPulls(anyLong(), anyList());
        verify(store, never()).savePullsEtag(anyLong(), any());
        ArgumentCaptor<List<NewEvidence>> captured = ArgumentCaptor.forClass(List.class);
        verify(evidence).replaceLinked(eq(2L), eq(EvidenceSubjects.GIT_METADATA), eq(3L), captured.capture());
        assertThat(captured.getValue()).hasSize(2);
        assertThat(captured.getValue())
                .extracting(NewEvidence::excerpt)
                .anyMatch(text -> text.contains("omitted 7"))
                .anyMatch(text -> text.contains("PR_METADATA_PERMISSION_DENIED"));
    }

    @Test
    void unrelatedFailureStillFailsTheStep() throws Exception {
        fixture();
        when(pulls.fetchAll(anyString(), anyString(), anyString(), anyString(), any(Runnable.class)))
                .thenThrow(new RestClientException("synthetic generic failure"));
        assertThatThrownBy(() -> step.run(context)).isInstanceOf(RestClientException.class);
        assertThat(context.progress()).isEqualTo(70);
        verifyNoInteractions(evidence);
    }

    @Test
    void localProjectNeverReadsCredentialsOrFetchesGithubMetadata() throws Exception {
        fixture();
        when(project.getSourceType()).thenReturn("LOCAL");
        step.run(context);
        assertThat(context.progress()).isEqualTo(100);
        verifyNoInteractions(tokens, pulls);
        verify(store, never()).findPullsEtag(anyLong());
    }

    @Test
    void actualCollectorVerifiesEveryPageAndPublishesRowsAndEtagThroughTheSameBorrow() throws Exception {
        LeaseFixture f = new LeaseFixture();
        f.page(
                1,
                withSuccess(pullBody(1), MediaType.APPLICATION_JSON)
                        .header(HttpHeaders.LINK, "<ignored>; rel=\"next\"")
                        .header(HttpHeaders.ETAG, "page-one-etag"),
                () -> {});
        f.page(
                2,
                withSuccess(pullBody(2), MediaType.APPLICATION_JSON).header(HttpHeaders.ETAG, "fetched-etag"),
                () -> {});

        f.step.run(context);

        assertThat(f.events)
                .containsExactly(
                        "borrow",
                        "verify",
                        "verify",
                        "http:1",
                        "verify",
                        "verify",
                        "http:2",
                        "verify",
                        "publish",
                        "pulls.save",
                        "etag.save");
        assertThat(f.savedPulls).containsExactlyInAnyOrderEntriesOf(Map.of(99, pull(99), 1, pull(1), 2, pull(2)));
        assertThat(f.savedEtag.get()).isEqualTo("fetched-etag");
        verify(store).upsertPulls(2L, List.of(pull(1), pull(2)));
        verify(store).savePullsEtag(2L, "fetched-etag");
        verify(evidence).deleteLinked(EvidenceSubjects.GIT_METADATA, 3L);
        verifyNoMoreInteractions(evidence);
        assertThat(context.progress()).isEqualTo(100);
        assertThat(f.row.get()).isSameAs(f.initial);
        verify(f.authStore, never()).compareAndSet(any(), any(), any());
        f.verifyUsage();
    }

    @Test
    void notModifiedStillVerifiesAndEntersThePublicationFenceWithoutChangingExistingRowsOrEtag() throws Exception {
        LeaseFixture f = new LeaseFixture();
        f.page(1, withStatus(HttpStatus.NOT_MODIFIED).header(HttpHeaders.ETAG, "observed-not-modified"), () -> {});

        f.step.run(context);

        assertThat(f.events).containsExactly("borrow", "verify", "verify", "http:1", "verify", "publish");
        f.assertNoPullPublication();
        verify(f.authStore, never()).compareAndSet(any(), any(), any());
        verify(evidence).deleteLinked(EvidenceSubjects.GIT_METADATA, 3L);
        assertThat(context.progress()).isEqualTo(100);
        f.verifyUsage();
    }

    @ParameterizedTest
    @ValueSource(ints = {1, 2})
    void aChangedCredentialOnAnyPageDiscardsThePartialListAndPreservesOldMetadata(int changedPage) throws Exception {
        LeaseFixture f = new LeaseFixture();
        StoredCredential replacement = metadataReplacement();
        f.page(
                1,
                withSuccess(pullBody(1), MediaType.APPLICATION_JSON)
                        .header(HttpHeaders.LINK, "<ignored>; rel=\"next\""),
                () -> {
                    if (changedPage == 1) f.row.set(replacement);
                });
        if (changedPage == 2)
            f.page(2, withSuccess(pullBody(2), MediaType.APPLICATION_JSON), () -> f.row.set(replacement));

        assertThatThrownBy(() -> f.step.run(context)).isInstanceOf(GithubReauthenticationRequiredException.class);

        if (changedPage == 1) {
            assertThat(f.events).containsExactly("borrow", "verify", "verify", "http:1", "verify");
        } else {
            assertThat(f.events)
                    .containsExactly("borrow", "verify", "verify", "http:1", "verify", "verify", "http:2", "verify");
        }
        assertThat(f.row.get()).isSameAs(replacement);
        f.assertNoPullPublication();
        verify(f.authStore, never()).compareAndSet(any(), any(), any());
        verifyNoInteractions(evidence);
        assertThat(context.progress()).isEqualTo(70);
        f.verifyUsage();
    }

    @Test
    void verificationRejectsABorrowBeforeTheFirstMetadataRequest() throws Exception {
        LeaseFixture f = new LeaseFixture();
        f.beforeVerification = () -> f.row.set(null);

        assertThatThrownBy(() -> f.step.run(context)).isInstanceOf(GithubReauthenticationRequiredException.class);

        assertThat(f.events).containsExactly("borrow", "verify");
        f.assertNoPullPublication();
        verify(f.authStore, never()).compareAndSet(any(), any(), any());
        verifyNoInteractions(evidence);
        assertThat(context.progress()).isEqualTo(70);
        f.verifyUsage();
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void publicationRechecksTheBorrowEvenAfterSuccessfulOrNotModifiedCollection(boolean notModified) throws Exception {
        LeaseFixture f = new LeaseFixture();
        ResponseCreator response = notModified
                ? withStatus(HttpStatus.NOT_MODIFIED)
                : withSuccess(pullBody(1), MediaType.APPLICATION_JSON).header(HttpHeaders.ETAG, "unpublished-etag");
        f.page(1, response, () -> {});
        f.beforePublication = () -> f.row.set(metadataReplacement());

        assertThatThrownBy(() -> f.step.run(context)).isInstanceOf(GithubReauthenticationRequiredException.class);

        assertThat(f.events).containsExactly("borrow", "verify", "verify", "http:1", "verify", "publish");
        f.assertNoPullPublication();
        verify(f.authStore, never()).compareAndSet(any(), any(), any());
        verifyNoInteractions(evidence);
        assertThat(context.progress()).isEqualTo(70);
        f.verifyUsage();
    }

    @Test
    void actualTokenRejectionInvalidatesTheCapturedLeaseAndDoesNotBecomeAnOptionalPermissionWarning() throws Exception {
        LeaseFixture f = new LeaseFixture();
        f.page(1, withStatus(HttpStatus.UNAUTHORIZED).body("untrusted synthetic-token"), () -> {});

        assertThatThrownBy(() -> f.step.run(context))
                .isInstanceOf(InvalidGithubTokenException.class)
                .satisfies(failure -> {
                    InvalidGithubTokenException problem = (InvalidGithubTokenException) failure;
                    assertThat(problem.getStatusCode().value()).isEqualTo(401);
                    assertThat(problem.failureCode()).isEqualTo("GITHUB_REAUTHENTICATION_REQUIRED");
                    assertThat(problem.getBody().getProperties()).containsEntry("reason", "TOKEN_REJECTED");
                    assertThat(problem.getCause()).isNull();
                })
                .hasMessageNotContaining("synthetic-token");

        assertThat(f.events).containsExactly("borrow", "verify", "verify", "http:1", "reject", "invalidate");
        assertThat(f.row.get().expiresAt()).isEqualTo(Instant.EPOCH);
        verify(f.authStore).compareAndSet(eq(f.initial), any(), eq(Instant.EPOCH));
        f.assertNoPullPublication();
        verifyNoInteractions(evidence);
        assertThat(context.progress()).isEqualTo(70);
        f.verifyUsage();
    }

    @Test
    void aLateMetadata401CannotRevokeAReconnectedIdenticalToken() throws Exception {
        LeaseFixture f = new LeaseFixture();
        StoredCredential replacement = metadataReplacement();
        f.page(1, withStatus(HttpStatus.UNAUTHORIZED), () -> f.row.set(replacement));

        assertThatThrownBy(() -> f.step.run(context)).isInstanceOf(InvalidGithubTokenException.class);

        assertThat(f.events).containsExactly("borrow", "verify", "verify", "http:1", "reject");
        assertThat(f.row.get()).isSameAs(replacement);
        verify(f.authStore, never()).compareAndSet(any(), any(), any());
        f.assertNoPullPublication();
        verifyNoInteractions(evidence);
        assertThat(context.progress()).isEqualTo(70);
        f.verifyUsage();
    }

    @ParameterizedTest
    @ValueSource(ints = {403, 429, 502})
    void generalForbiddenRateLimitsAndServerErrorsAreFatalWithoutRevocation(int status) throws Exception {
        LeaseFixture f = new LeaseFixture();
        f.page(
                1,
                withStatus(HttpStatus.valueOf(status))
                        .body("{\"message\":\"Organization SSO authorization required\"}"),
                () -> {});
        Class<? extends RuntimeException> expected =
                status == 429 ? GithubRateLimitException.class : RestClientException.class;

        assertThatThrownBy(() -> f.step.run(context))
                .isInstanceOf(expected)
                .isNotInstanceOf(GithubPullRequestsPermissionException.class);

        assertThat(f.events).containsExactly("borrow", "verify", "verify", "http:1");
        assertThat(f.row.get()).isSameAs(f.initial);
        verify(f.authStore, never()).compareAndSet(any(), any(), any());
        f.assertNoPullPublication();
        verifyNoInteractions(evidence);
        assertThat(context.progress()).isEqualTo(70);
        f.verifyUsage();
    }

    @Test
    void aRealOptionalPermissionDenialAfterOnePagePreservesAllPriorPrMetadata() throws Exception {
        LeaseFixture f = new LeaseFixture();
        f.page(
                1,
                withSuccess(pullBody(1), MediaType.APPLICATION_JSON)
                        .header(HttpHeaders.LINK, "<ignored>; rel=\"next\""),
                () -> {});
        f.page(
                2,
                withStatus(HttpStatus.FORBIDDEN).body("{\"message\":\"Resource not accessible by integration\"}"),
                () -> {});

        f.step.run(context);

        assertThat(f.events).containsExactly("borrow", "verify", "verify", "http:1", "verify", "verify", "http:2");
        f.assertNoPullPublication();
        verify(f.authStore, never()).compareAndSet(any(), any(), any());
        ArgumentCaptor<List<NewEvidence>> warnings = ArgumentCaptor.forClass(List.class);
        verify(evidence).replaceLinked(eq(2L), eq(EvidenceSubjects.GIT_METADATA), eq(3L), warnings.capture());
        assertThat(warnings.getValue())
                .singleElement()
                .satisfies(warning ->
                        assertThat(warning.excerpt()).contains("PR_METADATA_PERMISSION_DENIED", "unchanged"));
        assertThat(context.progress()).isEqualTo(100);
        f.verifyUsage();
    }

    private static GithubPullSummary pull(int number) {
        return new GithubPullSummary(
                number,
                "Synthetic pull " + number,
                null,
                "open",
                "octocat",
                null,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    }

    private static String pullBody(int number) {
        return "[{\"number\":" + number + ",\"title\":\"Synthetic pull " + number
                + "\",\"state\":\"open\",\"user\":{\"login\":\"octocat\"},"
                + "\"head\":{\"sha\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"},"
                + "\"base\":{\"sha\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}}]";
    }

    private static StoredCredential metadataReplacement() {
        return new StoredCredential(11L, 4L, CredentialKind.PAT, 1, new byte[12], "synthetic-replacement", null, 42L);
    }

    /** The real collector and lifecycle execute their callbacks; stored rows are observable in memory. */
    private final class LeaseFixture {
        private static final String BASE = "https://api.github.test";
        private final List<String> events = new ArrayList<>();
        private final StoredCredential initial =
                new StoredCredential(11L, 4L, CredentialKind.PAT, 1, new byte[12], "synthetic-original", null, 42L);
        private final AtomicReference<StoredCredential> row = new AtomicReference<>(initial);
        private final GithubCredentialStore authStore = mock(GithubCredentialStore.class);
        private final Map<Integer, GithubPullSummary> savedPulls = new LinkedHashMap<>(Map.of(99, pull(99)));
        private final AtomicReference<String> savedEtag = new AtomicReference<>("preserved-etag");
        private final RestClient.Builder builder = RestClient.builder();
        private final MockRestServiceServer server =
                MockRestServiceServer.bindTo(builder).build();
        private final GithubApiClient api =
                new GithubApiClient(builder, new GithubProperties(BASE, "https://github.com"));
        private final Sleeper sleeper = mock(Sleeper.class);
        private final AnalysisProperties properties = new AnalysisProperties(20000, 1048576, 10000, 0, 1000, 0.5);
        private final PullRequestCollector collector = spy(new PullRequestCollector(api, properties, sleeper));
        private final GitMetadataStep step =
                new GitMetadataStep(scanner, store, collector, projects, tokens, properties, evidence);
        private final GitMetadataScan scan = new GitMetadataScan(List.of(), List.of(), List.of(), 0);
        private Runnable beforeVerification = () -> {};
        private Runnable beforePublication = () -> {};
        private boolean publishing;

        private LeaseFixture() throws Exception {
            fixture();
            when(scanner.scan(context.clonePath(), 10000)).thenReturn(scan);
            doAnswer(invocation -> {
                        assertThat(publishing).isTrue();
                        events.add("pulls.save");
                        List<GithubPullSummary> fetched = invocation.getArgument(1);
                        fetched.forEach(pull -> savedPulls.put(pull.number(), pull));
                        return null;
                    })
                    .when(store)
                    .upsertPulls(eq(2L), anyList());
            doAnswer(invocation -> {
                        assertThat(publishing).isTrue();
                        events.add("etag.save");
                        savedEtag.set(invocation.getArgument(1));
                        return null;
                    })
                    .when(store)
                    .savePullsEtag(eq(2L), any());
            TokenCryptoService crypto = mock(TokenCryptoService.class);
            when(crypto.decrypt(eq(1), any(byte[].class), anyString())).thenReturn("synthetic-token");
            when(authStore.find(4L)).thenAnswer(invocation -> Optional.ofNullable(row.get()));
            when(authStore.compareAndSet(any(), any(), any())).thenAnswer(invocation -> {
                StoredCredential expected = invocation.getArgument(0);
                boolean changed = row.compareAndSet(
                        expected, expected.replaced(invocation.getArgument(1), invocation.getArgument(2)));
                if (changed) events.add("invalidate");
                return changed;
            });
            GithubTokenLifecycle lifecycle = new GithubTokenLifecycle(
                    authStore,
                    mock(GithubDeviceCredentialCodec.class),
                    crypto,
                    new GithubConnectionCoordinator(),
                    new GithubNativeOAuthProperties(
                            "synthetic-client", "https://github.test/device", "https://github.test/token", "", 300),
                    api,
                    RestClient.builder());
            doAnswer(invocation -> {
                        events.add("borrow");
                        return lifecycle
                                .borrow(4L)
                                .map(borrowed -> new GithubTokenProvider.BorrowedToken(
                                        borrowed.value(),
                                        () -> {
                                            events.add("verify");
                                            beforeVerification.run();
                                            borrowed.verify();
                                        },
                                        () -> {
                                            events.add("reject");
                                            borrowed.reject();
                                        },
                                        action -> {
                                            events.add("publish");
                                            assertThat(savedPulls)
                                                    .containsExactlyInAnyOrderEntriesOf(Map.of(99, pull(99)));
                                            assertThat(savedEtag.get()).isEqualTo("preserved-etag");
                                            beforePublication.run();
                                            borrowed.publish(() -> {
                                                publishing = true;
                                                try {
                                                    action.run();
                                                } finally {
                                                    publishing = false;
                                                }
                                            });
                                        },
                                        () -> {
                                            throw new AssertionError(
                                                    "Metadata collection must not probe clone failures");
                                        }));
                    })
                    .when(tokens)
                    .findCredential(4L);
        }

        private void page(int page, ResponseCreator response, Runnable duringResponse) {
            server.expect(requestTo(BASE + "/repos/synthetic/fixture/pulls?state=all&per_page=100&page=" + page))
                    .andExpect(method(HttpMethod.GET))
                    .andExpect(header(HttpHeaders.AUTHORIZATION, "Bearer synthetic-token"))
                    .andExpect(request -> {
                        if (page == 1)
                            assertThat(request.getHeaders().getFirst(HttpHeaders.IF_NONE_MATCH))
                                    .isEqualTo("preserved-etag");
                        else
                            assertThat(request.getHeaders().getFirst(HttpHeaders.IF_NONE_MATCH))
                                    .isNull();
                    })
                    .andRespond(request -> {
                        assertThat(events.getLast()).isEqualTo("verify");
                        events.add("http:" + page);
                        duringResponse.run();
                        return response.createResponse(request);
                    });
        }

        private void assertNoPullPublication() {
            assertThat(savedPulls).containsExactlyInAnyOrderEntriesOf(Map.of(99, pull(99)));
            assertThat(savedEtag.get()).isEqualTo("preserved-etag");
            verify(store, never()).upsertPulls(anyLong(), anyList());
            verify(store, never()).savePullsEtag(anyLong(), any());
        }

        private void verifyUsage() {
            verify(tokens).findCredential(4L);
            verifyNoMoreInteractions(tokens);
            verify(collector)
                    .fetchAll(
                            eq("synthetic-token"),
                            eq("synthetic"),
                            eq("fixture"),
                            eq("preserved-etag"),
                            any(Runnable.class));
            verifyNoMoreInteractions(collector);
            verify(store).replaceCloneMetadata(2L, scan);
            verifyNoInteractions(pulls, sleeper);
            server.verify();
        }
    }
}
