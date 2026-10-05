package dev.codeintelligence.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withException;
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
import dev.codeintelligence.common.security.CredentialKind;
import dev.codeintelligence.github.GitCloneException;
import dev.codeintelligence.github.GitCloneService;
import dev.codeintelligence.github.GithubApiClient;
import dev.codeintelligence.github.GithubProperties;
import dev.codeintelligence.github.GithubTokenProvider;
import dev.codeintelligence.github.InvalidGithubTokenException;
import dev.codeintelligence.job.JobWorkspaceProvider;
import dev.codeintelligence.testsupport.TestJobContext;
import java.io.IOException;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.test.web.client.ResponseCreator;
import org.springframework.web.client.RestClient;

/** No clone, filesystem or DB is opened. Actual borrowed callbacks fence observable publication. */
class ImportCredentialLeaseTest {
    private static final long USER = 7L;
    private static final long PROJECT = 2L;
    private static final long SNAPSHOT = 3L;
    private static final String TOKEN = "synthetic-import-token";
    private static final String BASE = "https://api.github.test";
    private static final String URL = "https://github.com/octocat/fixture.git";
    private static final String OLD_BRANCH = "legacy-main";
    private static final String HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static final Path CLONE_PATH = Path.of("/synthetic/not-read/import");

    @Test
    void onlyAnAbsentStoredCredentialPermitsAnonymousCloneAndPublication() {
        Fixture f = new Fixture();
        f.row.set(null);
        f.anonymous = true;
        f.cloneWith(null, () -> new GitCloneService.CloneResult(HEAD, "main"));

        f.step.run(f.context);

        assertThat(f.events).containsExactly("borrow", "clone", "branch.save", "snapshot.save");
        f.assertPublished();
        f.verifyProvider();
    }

    @Test
    void expiredStoredCredentialsFailBeforeCloneWithoutAnonymousFallback() {
        Fixture f = new Fixture();
        f.row.set(new StoredCredential(
                11L, USER, CredentialKind.OAUTH, 1, new byte[12], "synthetic-expired", Instant.EPOCH, 42L));

        assertThatThrownBy(() -> f.step.run(f.context))
                .isInstanceOf(GithubReauthenticationRequiredException.class)
                .satisfies(failure -> assertThat(((GithubReauthenticationRequiredException) failure)
                                .getBody()
                                .getProperties())
                        .containsEntry("code", "GITHUB_REAUTHENTICATION_REQUIRED")
                        .containsEntry("reason", "TOKEN_EXPIRED"));

        assertThat(f.events).containsExactly("borrow");
        verifyNoInteractions(f.clones);
        f.assertNotPublished();
        f.verifyProvider();
    }

    @Test
    void credentialResolutionFailuresDoNotBecomeAnonymousClone() {
        Fixture f = new Fixture();
        var unavailable = new GithubReauthenticationRequiredException("REFRESH_UNCERTAIN");
        doThrow(unavailable).when(f.tokens).findCredential(USER);

        assertThatThrownBy(() -> f.step.run(f.context)).isSameAs(unavailable);

        verifyNoInteractions(f.clones);
        f.assertNotPublished();
        f.verifyProvider();
    }

    @Test
    void successfulClonePublishesBranchAndSnapshotInsideTheSameBorrowedCredentialFence() {
        Fixture f = new Fixture();
        f.cloneWith(TOKEN, () -> new GitCloneService.CloneResult(HEAD, "main"));

        f.step.run(f.context);

        assertThat(f.events).containsExactly("borrow", "verify", "clone", "publish", "branch.save", "snapshot.save");
        assertThat(f.row.get()).isSameAs(f.initial);
        f.assertPublished();
        f.verifyProvider();
    }

    @Test
    void aBorrowInvalidatedBeforeClonePreventsAnyCloneCall() {
        Fixture f = new Fixture();
        f.beforeVerification = () -> f.row.set(null);

        assertThatThrownBy(() -> f.step.run(f.context)).isInstanceOf(GithubReauthenticationRequiredException.class);

        assertThat(f.events).containsExactly("borrow", "verify");
        verifyNoInteractions(f.clones);
        f.assertNotPublished();
        f.verifyProvider();
    }

    @ParameterizedTest
    @ValueSource(strings = {"DISCONNECT", "SAME_TOKEN_RECONNECT", "GITHUB_OWNER_CHANGED"})
    void aConnectionChangeDuringClonePreventsBothDefaultBranchAndSnapshotPublication(String change) {
        Fixture f = new Fixture();
        StoredCredential replacement =
                switch (change) {
                    case "DISCONNECT" -> null;
                    case "GITHUB_OWNER_CHANGED" ->
                        new StoredCredential(
                                f.initial.id(),
                                USER,
                                f.initial.kind(),
                                f.initial.keyVersion(),
                                f.initial.nonce(),
                                f.initial.ciphertext(),
                                f.initial.expiresAt(),
                                99L);
                    default -> replacement();
                };
        f.cloneWith(TOKEN, () -> {
            f.row.set(replacement);
            return new GitCloneService.CloneResult(HEAD, "main");
        });

        assertThatThrownBy(() -> f.step.run(f.context)).isInstanceOf(GithubReauthenticationRequiredException.class);

        assertThat(f.events).containsExactly("borrow", "verify", "clone", "publish");
        assertThat(f.row.get()).isSameAs(replacement);
        verify(f.clones).cloneOrFetch(CLONE_PATH, URL, TOKEN, OLD_BRANCH);
        verifyNoMoreInteractions(f.clones);
        f.assertNotPublished();
        f.verifyProvider();
    }

    @Test
    void publicationRechecksAfterCloneReturnsRatherThanRelyingOnItsEarlierVerification() {
        Fixture f = new Fixture();
        f.cloneWith(TOKEN, () -> new GitCloneService.CloneResult(HEAD, "main"));
        f.beforePublication = () -> f.row.set(replacement());

        assertThatThrownBy(() -> f.step.run(f.context)).isInstanceOf(GithubReauthenticationRequiredException.class);

        assertThat(f.events).containsExactly("borrow", "verify", "clone", "publish");
        f.assertNotPublished();
        f.verifyProvider();
    }

    @ParameterizedTest
    @ValueSource(ints = {200, 403, 429, 502})
    void cloneFailureKeepsTheOriginalErrorWhenTheProfileProbeDoesNotProve401(int status) {
        Fixture f = new Fixture();
        GitCloneException original = cloneFailure();
        f.cloneWith(TOKEN, () -> {
            throw original;
        });
        ResponseCreator response =
                switch (status) {
                    case 200 -> withSuccess("{\"id\":42,\"login\":\"octocat\"}", MediaType.APPLICATION_JSON);
                    case 429 ->
                        withStatus(HttpStatus.TOO_MANY_REQUESTS)
                                .header(HttpHeaders.RETRY_AFTER, "1")
                                .body("{\"message\":\"401 Bad credentials\"}");
                    default -> withStatus(HttpStatus.valueOf(status)).body("{\"message\":\"401 Bad credentials\"}");
                };
        f.probe(response, () -> {});

        assertThatThrownBy(() -> f.step.run(f.context)).isSameAs(original);

        assertThat(f.events).containsExactly("borrow", "verify", "clone", "failure.check", "probe.http");
        assertThat(f.row.get()).isSameAs(f.initial);
        f.assertNotPublished();
        f.verifyProvider();
    }

    @Test
    void aProbeTransportFailureKeepsTheCloneErrorWithoutRetryOrRevocation() {
        Fixture f = new Fixture();
        GitCloneException original = cloneFailure();
        f.cloneWith(TOKEN, () -> {
            throw original;
        });
        f.probe(withException(new IOException("Synthetic profile transport failure")), () -> {});

        assertThatThrownBy(() -> f.step.run(f.context)).isSameAs(original);

        assertThat(f.events).containsExactly("borrow", "verify", "clone", "failure.check", "probe.http");
        f.assertNotPublished();
        f.verifyProvider();
    }

    @Test
    void anActual401FromTheProfileProbeReplacesTheCloneErrorWithAnAuthMachineCode() {
        Fixture f = new Fixture();
        f.cloneWith(TOKEN, () -> {
            throw cloneFailure();
        });
        f.probe(withStatus(HttpStatus.UNAUTHORIZED).body("untrusted " + TOKEN), () -> {});

        assertThatThrownBy(() -> f.step.run(f.context))
                .isInstanceOf(InvalidGithubTokenException.class)
                .satisfies(failure -> {
                    InvalidGithubTokenException problem = (InvalidGithubTokenException) failure;
                    assertThat(problem.getStatusCode().value()).isEqualTo(401);
                    assertThat(problem.failureCode()).isEqualTo("GITHUB_REAUTHENTICATION_REQUIRED");
                    assertThat(problem.getBody().getProperties())
                            .containsEntry("code", "GITHUB_REAUTHENTICATION_REQUIRED")
                            .containsEntry("reason", "TOKEN_REJECTED");
                    assertThat(problem.getCause()).isNull();
                })
                .hasMessageNotContaining(TOKEN);

        assertThat(f.events).containsExactly("borrow", "verify", "clone", "failure.check", "probe.http", "invalidate");
        assertThat(f.row.get().expiresAt()).isEqualTo(Instant.EPOCH);
        verify(f.store).compareAndSet(eq(f.initial), any(), eq(Instant.EPOCH));
        f.assertNotPublished(false);
        f.verifyProvider();
    }

    @Test
    void aLateProbe401CannotInvalidateAReconnectedCredentialWithTheSameTokenValue() {
        Fixture f = new Fixture();
        StoredCredential replacement = replacement();
        f.cloneWith(TOKEN, () -> {
            throw cloneFailure();
        });
        f.probe(withStatus(HttpStatus.UNAUTHORIZED), () -> f.row.set(replacement));

        assertThatThrownBy(() -> f.step.run(f.context)).isInstanceOf(InvalidGithubTokenException.class);

        assertThat(f.events).containsExactly("borrow", "verify", "clone", "failure.check", "probe.http");
        assertThat(f.row.get()).isSameAs(replacement);
        f.assertNotPublished();
        f.verifyProvider();
    }

    @Test
    void aStaleLeaseStopsTheFailureProbeBeforeAnyProfileRequest() {
        Fixture f = new Fixture();
        f.cloneWith(TOKEN, () -> {
            f.row.set(replacement());
            throw cloneFailure();
        });

        assertThatThrownBy(() -> f.step.run(f.context)).isInstanceOf(GithubReauthenticationRequiredException.class);

        assertThat(f.events).containsExactly("borrow", "verify", "clone", "failure.check");
        f.assertNotPublished();
        f.verifyProvider();
    }

    @Test
    void anAnonymousCloneFailureCannotProbeOrAcquireNewCredentials() {
        Fixture f = new Fixture();
        f.row.set(null);
        f.anonymous = true;
        GitCloneException original = cloneFailure();
        f.cloneWith(null, () -> {
            throw original;
        });

        assertThatThrownBy(() -> f.step.run(f.context)).isSameAs(original);

        assertThat(f.events).containsExactly("borrow", "clone");
        f.assertNotPublished();
        f.verifyProvider();
    }

    private static GitCloneException cloneFailure() {
        return new GitCloneException(
                "Synthetic git transport mentioned 401; status is unproved", new IOException("Synthetic cause"));
    }

    private static StoredCredential replacement() {
        return new StoredCredential(11L, USER, CredentialKind.PAT, 1, new byte[12], "synthetic-replacement", null, 42L);
    }

    private static final class Fixture {
        private final ProjectRepository projects = mock(ProjectRepository.class);
        private final SnapshotRepository snapshots = mock(SnapshotRepository.class);
        private final GitCloneService clones = mock(GitCloneService.class);
        private final GithubTokenProvider tokens = mock(GithubTokenProvider.class);
        private final LocalImportService localImport = mock(LocalImportService.class);
        private final LocalImportDiagnostics diagnostics = mock(LocalImportDiagnostics.class);
        private final LocalSourceApprovalService approvals = mock(LocalSourceApprovalService.class);
        private final LocalSnapshotStore retained = mock(LocalSnapshotStore.class);
        private final JobWorkspaceProvider workspaces = mock(JobWorkspaceProvider.class);
        private final Project project = new Project(USER, "Synthetic project", "octocat", "fixture");
        private final TestJobContext context = new TestJobContext(1L, PROJECT, null, CLONE_PATH);
        private final ImportStep step = new ImportStep(
                projects,
                snapshots,
                clones,
                tokens,
                new GithubProperties(BASE, "https://github.com"),
                localImport,
                diagnostics,
                approvals,
                retained,
                workspaces);
        private final List<String> events = new ArrayList<>();
        private final StoredCredential initial =
                new StoredCredential(11L, USER, CredentialKind.PAT, 1, new byte[12], "synthetic-original", null, 42L);
        private final AtomicReference<StoredCredential> row = new AtomicReference<>(initial);
        private final GithubCredentialStore store = mock(GithubCredentialStore.class);
        private final RestClient.Builder builder = RestClient.builder();
        private final MockRestServiceServer server =
                MockRestServiceServer.bindTo(builder).build();
        private final GithubApiClient api =
                new GithubApiClient(builder, new GithubProperties(BASE, "https://github.com"));
        private Runnable beforeVerification = () -> {};
        private Runnable beforePublication = () -> {};
        private boolean publishing;
        private boolean anonymous;

        private Fixture() {
            ReflectionTestUtils.setField(project, "id", PROJECT);
            project.updateDefaultBranch(OLD_BRANCH);
            when(projects.findById(PROJECT)).thenReturn(Optional.of(project));
            when(projects.save(project)).thenAnswer(invocation -> {
                assertThat(anonymous || publishing).isTrue();
                events.add("branch.save");
                return project;
            });
            when(snapshots.save(any(Snapshot.class))).thenAnswer(invocation -> {
                assertThat(anonymous || publishing).isTrue();
                events.add("snapshot.save");
                Snapshot snapshot = invocation.getArgument(0);
                ReflectionTestUtils.setField(snapshot, "id", SNAPSHOT);
                return snapshot;
            });
            TokenCryptoService crypto = mock(TokenCryptoService.class);
            when(crypto.decrypt(eq(1), any(byte[].class), anyString())).thenReturn(TOKEN);
            when(store.find(USER)).thenAnswer(invocation -> Optional.ofNullable(row.get()));
            when(store.compareAndSet(any(), any(), any())).thenAnswer(invocation -> {
                StoredCredential expected = invocation.getArgument(0);
                boolean changed = row.compareAndSet(
                        expected, expected.replaced(invocation.getArgument(1), invocation.getArgument(2)));
                if (changed) events.add("invalidate");
                return changed;
            });
            // A non-renewable synthetic PAT selects the real borrow/probe logic without a refresh exchange.
            GithubTokenLifecycle lifecycle = new GithubTokenLifecycle(
                    store,
                    mock(GithubDeviceCredentialCodec.class),
                    crypto,
                    new GithubConnectionCoordinator(),
                    new GithubNativeOAuthProperties(
                            "synthetic-client", "https://github.test/device", "https://github.test/token", "", 300),
                    api,
                    RestClient.builder());
            when(tokens.findCredential(USER)).thenAnswer(invocation -> {
                events.add("borrow");
                return lifecycle
                        .borrow(USER)
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
                                    assertThat(project.getDefaultBranch()).isEqualTo(OLD_BRANCH);
                                    assertThat(context.snapshotId()).isEmpty();
                                    verifyNoInteractions(snapshots);
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
                                    events.add("failure.check");
                                    borrowed.checkAfterTransportFailure();
                                }));
            });
        }

        private void cloneWith(String token, Supplier<GitCloneService.CloneResult> result) {
            when(clones.cloneOrFetch(CLONE_PATH, URL, token, OLD_BRANCH)).thenAnswer(invocation -> {
                events.add("clone");
                return result.get();
            });
        }

        private void probe(ResponseCreator response, Runnable duringResponse) {
            server.expect(requestTo(BASE + "/user"))
                    .andExpect(method(HttpMethod.GET))
                    .andExpect(header(HttpHeaders.AUTHORIZATION, "Bearer " + TOKEN))
                    .andRespond(request -> {
                        assertThat(events).containsExactly("borrow", "verify", "clone", "failure.check");
                        events.add("probe.http");
                        duringResponse.run();
                        return response.createResponse(request);
                    });
        }

        private void assertPublished() {
            assertThat(project.getDefaultBranch()).isEqualTo("main");
            verify(projects).save(project);
            ArgumentCaptor<Snapshot> captured = ArgumentCaptor.forClass(Snapshot.class);
            verify(snapshots).save(captured.capture());
            assertThat(captured.getValue().getProjectId()).isEqualTo(PROJECT);
            assertThat(captured.getValue().getCommitSha()).isEqualTo(HEAD);
            assertThat(captured.getValue().getStatus()).isEqualTo(SnapshotStatus.ANALYZING);
            assertThat(context.snapshotId()).contains(SNAPSHOT);
            verify(clones).cloneOrFetch(CLONE_PATH, URL, anonymous ? null : TOKEN, OLD_BRANCH);
            verifyNoMoreInteractions(clones, snapshots);
        }

        private void assertNotPublished() {
            assertNotPublished(true);
        }

        private void assertNotPublished(boolean noRevocation) {
            assertThat(project.getDefaultBranch()).isEqualTo(OLD_BRANCH);
            assertThat(context.snapshotId()).isEmpty();
            verify(projects, never()).save(any());
            verifyNoInteractions(snapshots);
            if (noRevocation) verify(store, never()).compareAndSet(any(), any(), any());
        }

        private void verifyProvider() {
            verify(tokens).findCredential(USER);
            verifyNoMoreInteractions(tokens);
            verifyNoInteractions(localImport, diagnostics, approvals, retained, workspaces);
            server.verify();
        }
    }
}
