package dev.codeintelligence.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import dev.codeintelligence.common.security.AuthenticatedUser;
import dev.codeintelligence.common.security.CredentialKind;
import dev.codeintelligence.github.GithubApiClient;
import dev.codeintelligence.github.GithubProperties;
import dev.codeintelligence.github.GithubUserInfo;
import dev.codeintelligence.github.InvalidGithubTokenException;
import java.io.IOException;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

class PatAuthServiceTest {

    private static final String BASE_URL = "https://api.github.test";
    private static final String VALID_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
    private static final String LOCAL_IDENTITY = "synthetic-installation";
    private static final DesktopAuthProperties DESKTOP =
            new DesktopAuthProperties("synthetic-launch-capability", LOCAL_IDENTITY, "https://127.0.0.1:4311");
    private static final GithubUserInfo PROFILE =
            new GithubUserInfo(42L, "octocat", "Octo Cat", "https://avatars.test/octocat.png", "repo, read:user");

    private final RestClient.Builder builder = RestClient.builder();
    private final MockRestServiceServer server =
            MockRestServiceServer.bindTo(builder).build();
    private final GithubApiClient githubApiClient =
            new GithubApiClient(builder, new GithubProperties(BASE_URL, "https://github.com"));

    private final UserAccountRepository userAccountRepository = mock(UserAccountRepository.class);
    private final GithubCredentialRepository credentialRepository = mock(GithubCredentialRepository.class);
    private final TokenCryptoService tokenCryptoService = new TokenCryptoService(new TokenCryptoProperties(VALID_KEY));
    private final AccountService accountService =
            new AccountService(userAccountRepository, credentialRepository, tokenCryptoService);
    private final PatAuthService patAuthService =
            new PatAuthService(githubApiClient, accountService, new HttpSessionSecurityContextRepository());

    private final MockHttpServletRequest request = new MockHttpServletRequest();
    private final MockHttpServletResponse response = new MockHttpServletResponse();

    @AfterEach
    void clearSecurityContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void validPatUpsertsUserStoresEncryptedCredentialAndCreatesSession() {
        expectGithubUser();
        when(userAccountRepository.findByGithubId(42L)).thenReturn(Optional.empty());
        when(userAccountRepository.save(any())).thenAnswer(invocation -> {
            UserAccount account = invocation.getArgument(0);
            ReflectionTestUtils.setField(account, "id", 7L);
            return account;
        });
        when(credentialRepository.findByUserIdAndKind(7L, CredentialKind.PAT)).thenReturn(Optional.empty());
        when(credentialRepository.save(any())).thenAnswer(invocation -> invocation.getArgument(0));

        patAuthService.login("ghp_valid-token", request, response);

        ArgumentCaptor<GithubCredential> credentialCaptor = ArgumentCaptor.forClass(GithubCredential.class);
        verify(credentialRepository).save(credentialCaptor.capture());
        GithubCredential saved = credentialCaptor.getValue();
        assertThat(saved.getKind()).isEqualTo(CredentialKind.PAT);
        assertThat(saved.getKeyVersion()).isEqualTo(1);
        assertThat(saved.getNonce()).hasSize(12);
        assertThat(saved.getScopes()).isEqualTo("repo, read:user");
        assertThat(saved.getEncryptedToken()).doesNotContain("ghp_valid-token");
        assertThat(tokenCryptoService.decrypt(saved.getKeyVersion(), saved.getNonce(), saved.getEncryptedToken()))
                .isEqualTo("ghp_valid-token");
        assertThat(saved.toString()).doesNotContain("ghp_valid-token").doesNotContain(saved.getEncryptedToken());

        SecurityContext stored = (SecurityContext) request.getSession(false)
                .getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY);
        assertThat(stored).isNotNull();
        AuthenticatedUser principal =
                (AuthenticatedUser) stored.getAuthentication().getPrincipal();
        assertThat(principal.userId()).isEqualTo(7L);
        assertThat(principal.login()).isEqualTo("octocat");
        assertThat(principal.credentialKind()).isEqualTo(CredentialKind.PAT);
    }

    @Test
    void existingUserAndCredentialAreUpdatedInPlace() {
        expectGithubUser();
        UserAccount existingUser = new UserAccount(42L, "old-login", null, null);
        ReflectionTestUtils.setField(existingUser, "id", 7L);
        GithubCredential existingCredential =
                new GithubCredential(7L, CredentialKind.PAT, tokenCryptoService.encrypt("ghp_old-token"), null);
        when(userAccountRepository.findByGithubId(42L)).thenReturn(Optional.of(existingUser));
        when(credentialRepository.findByUserIdAndKind(7L, CredentialKind.PAT))
                .thenReturn(Optional.of(existingCredential));

        patAuthService.login("ghp_valid-token", request, response);

        verify(userAccountRepository, never()).save(any());
        verify(credentialRepository, never()).save(any());
        assertThat(existingUser.getLogin()).isEqualTo("octocat");
        assertThat(tokenCryptoService.decrypt(
                        existingCredential.getKeyVersion(),
                        existingCredential.getNonce(),
                        existingCredential.getEncryptedToken()))
                .isEqualTo("ghp_valid-token");
    }

    @Test
    void rejectedPatBecomes401ProblemDetailAndNothingIsPersisted() {
        server.expect(requestTo(BASE_URL + "/user")).andRespond(withStatus(HttpStatus.UNAUTHORIZED));

        assertThatThrownBy(() -> patAuthService.login("ghp_rejected-secret", request, response))
                .isInstanceOf(InvalidGithubTokenException.class)
                .satisfies(e -> {
                    InvalidGithubTokenException ex = (InvalidGithubTokenException) e;
                    assertThat(ex.getStatusCode().value()).isEqualTo(401);
                    assertThat(ex.getBody().getDetail()).doesNotContain("ghp_rejected-secret");
                })
                .hasMessageNotContaining("ghp_rejected-secret");

        verifyNoInteractions(userAccountRepository, credentialRepository);
        assertThat(request.getSession(false)).isNull();
    }

    @Test
    void desktopPatLinksOnlyTheInstallationLocalUserWithoutReplacingItsSessionIdentity() {
        expectGithubUser();
        UserAccount local = localAccount(7L);
        when(userAccountRepository.findByLocalKey(LOCAL_IDENTITY)).thenReturn(Optional.of(local));
        when(userAccountRepository.findById(7L)).thenReturn(Optional.of(local));
        when(userAccountRepository.findByGithubId(PROFILE.id())).thenReturn(Optional.empty());
        when(credentialRepository.findByUserIdAndKind(7L, CredentialKind.PAT)).thenReturn(Optional.empty());
        when(credentialRepository.save(any())).thenAnswer(invocation -> invocation.getArgument(0));
        AccountService observedAccounts = spy(accountService);
        SecurityContextRepository sessions = mock(SecurityContextRepository.class);
        GithubConnectionCoordinator connections = new GithubConnectionCoordinator();
        PatAuthService desktopPat =
                new PatAuthService(githubApiClient, observedAccounts, sessions, connections, DESKTOP);
        SecurityContext localContext = localContext(7L);
        SecurityContextHolder.setContext(localContext);
        var localAuthentication = localContext.getAuthentication();
        MockHttpSession session = new MockHttpSession();
        session.setAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY, localContext);
        request.setSession(session);
        String sessionId = session.getId();

        desktopPat.login("  ghp_valid-token  ", request, response);

        verify(observedAccounts).getOrCreateLocal(LOCAL_IDENTITY);
        verify(observedAccounts).linkLocalPat(7L, PROFILE, "ghp_valid-token");
        verifyNoMoreInteractions(observedAccounts);
        verify(userAccountRepository, never()).save(any());
        ArgumentCaptor<GithubCredential> saved = ArgumentCaptor.forClass(GithubCredential.class);
        verify(credentialRepository).save(saved.capture());
        assertThat(saved.getValue().getUserId()).isEqualTo(7L);
        assertThat(saved.getValue().getKind()).isEqualTo(CredentialKind.PAT);
        assertThat(saved.getValue().getKeyVersion()).isEqualTo(1);
        assertThat(tokenCryptoService.decrypt(
                        saved.getValue().getKeyVersion(),
                        saved.getValue().getNonce(),
                        saved.getValue().getEncryptedToken()))
                .isEqualTo("ghp_valid-token");
        verify(credentialRepository).deleteByUserIdAndKind(7L, CredentialKind.OAUTH);
        assertThat(local.getId()).isEqualTo(7L);
        assertThat(local.getGithubId()).isEqualTo(PROFILE.id());
        assertThat(local.getLocalKey()).isEqualTo(LOCAL_IDENTITY);
        assertThat(local.getIdentityType()).isEqualTo("LOCAL_LINKED");
        assertThat(SecurityContextHolder.getContext()).isSameAs(localContext);
        assertThat(localContext.getAuthentication()).isSameAs(localAuthentication);
        assertThat(((AuthenticatedUser) localAuthentication.getPrincipal()).credentialKind())
                .isEqualTo(CredentialKind.LOCAL);
        assertThat(request.getSession(false)).isSameAs(session);
        assertThat(session.getId()).isEqualTo(sessionId);
        assertThat(session.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY))
                .isSameAs(localContext);
        assertThat(response.getCookies()).isEmpty();
        assertThat(connections.connection(7L).value).isEqualTo(1L);
        verifyNoInteractions(sessions);
        server.verify();
    }

    @Test
    void desktopPatChecksTheOwnerThenUsesTheSharedGenerationBeforeAndAfterProviderIo() {
        GithubApiClient github = mock(GithubApiClient.class);
        AccountService accounts = mock(AccountService.class);
        SecurityContextRepository sessions = mock(SecurityContextRepository.class);
        GithubConnectionCoordinator connections = new GithubConnectionCoordinator();
        var connection = connections.connection(7L);
        long before = connection.value;
        UserAccount local = localAccount(7L);
        when(accounts.getOrCreateLocal(LOCAL_IDENTITY)).thenReturn(local);
        when(github.getUser("synthetic-pat")).thenAnswer(invocation -> {
            assertThat(connection.value).isEqualTo(before + 1);
            assertThat(Thread.holdsLock(connection)).isFalse();
            return PROFILE;
        });
        when(accounts.linkLocalPat(7L, PROFILE, "synthetic-pat")).thenAnswer(invocation -> {
            assertThat(connection.value).isEqualTo(before + 1);
            assertThat(Thread.holdsLock(connection)).isTrue();
            return local;
        });
        var desktopPat = new PatAuthService(github, accounts, sessions, connections, DESKTOP);
        SecurityContext localContext = localContext(7L);
        SecurityContextHolder.setContext(localContext);
        var localAuthentication = localContext.getAuthentication();

        desktopPat.login("synthetic-pat", request, response);

        var order = inOrder(accounts, github);
        order.verify(accounts).getOrCreateLocal(LOCAL_IDENTITY);
        order.verify(github).getUser("synthetic-pat");
        order.verify(accounts).linkLocalPat(7L, PROFILE, "synthetic-pat");
        order.verifyNoMoreInteractions();
        assertThat(connection.value).isEqualTo(before + 1);
        assertThat(connections.connection(8L).value).isZero();
        assertThat(SecurityContextHolder.getContext()).isSameAs(localContext);
        assertThat(localContext.getAuthentication()).isSameAs(localAuthentication);
        assertThat(request.getSession(false)).isNull();
        verifyNoInteractions(sessions);
    }

    @ParameterizedTest
    @ValueSource(strings = {"MISSING", "FOREIGN", "PAT", "OAUTH"})
    void desktopPatRejectsNonLocalPrincipalsBeforeOwnerLookupOrGithubIo(String kind) {
        GithubApiClient github = mock(GithubApiClient.class);
        AccountService accounts = mock(AccountService.class);
        SecurityContextRepository sessions = mock(SecurityContextRepository.class);
        GithubConnectionCoordinator connections = new GithubConnectionCoordinator();
        var desktopPat = new PatAuthService(github, accounts, sessions, connections, DESKTOP);
        SecurityContext previous = SecurityContextHolder.createEmptyContext();
        if (kind.equals("FOREIGN")) {
            previous.setAuthentication(
                    UsernamePasswordAuthenticationToken.authenticated("browser-principal", null, List.of()));
        } else if (!kind.equals("MISSING")) {
            AuthenticatedUser principal =
                    new AuthenticatedUser(7L, 42L, "octocat", null, null, CredentialKind.valueOf(kind));
            previous.setAuthentication(
                    UsernamePasswordAuthenticationToken.authenticated(principal, null, principal.getAuthorities()));
        }
        SecurityContextHolder.setContext(previous);
        var authentication = previous.getAuthentication();

        assertThatThrownBy(() -> desktopPat.login("synthetic-pat", request, response))
                .isInstanceOf(MissingCredentialException.class)
                .hasMessageNotContaining("synthetic-pat");

        verifyNoInteractions(github, accounts, sessions);
        assertThat(connections.connection(7L).value).isZero();
        assertThat(SecurityContextHolder.getContext()).isSameAs(previous);
        assertThat(previous.getAuthentication()).isSameAs(authentication);
        assertThat(request.getSession(false)).isNull();
    }

    @Test
    void desktopPatRejectsADifferentLocalOwnerBeforeAdvancingGenerationOrCallingGithub() {
        GithubApiClient github = mock(GithubApiClient.class);
        AccountService accounts = mock(AccountService.class);
        SecurityContextRepository sessions = mock(SecurityContextRepository.class);
        GithubConnectionCoordinator connections = new GithubConnectionCoordinator();
        when(accounts.getOrCreateLocal(LOCAL_IDENTITY)).thenReturn(localAccount(8L));
        var desktopPat = new PatAuthService(github, accounts, sessions, connections, DESKTOP);
        SecurityContext previous = localContext(7L);
        SecurityContextHolder.setContext(previous);
        var authentication = previous.getAuthentication();

        assertThatThrownBy(() -> desktopPat.login("synthetic-pat", request, response))
                .isInstanceOf(GithubReauthenticationRequiredException.class)
                .satisfies(failure -> {
                    var problem = (GithubReauthenticationRequiredException) failure;
                    assertThat(problem.getStatusCode().value()).isEqualTo(401);
                    assertThat(problem.getBody().getProperties()).containsEntry("reason", "CONNECTION_CHANGED");
                });

        verify(accounts).getOrCreateLocal(LOCAL_IDENTITY);
        verifyNoMoreInteractions(accounts);
        verifyNoInteractions(github, sessions);
        assertThat(connections.connection(7L).value).isZero();
        assertThat(connections.connection(8L).value).isZero();
        assertThat(SecurityContextHolder.getContext()).isSameAs(previous);
        assertThat(previous.getAuthentication()).isSameAs(authentication);
        assertThat(request.getSession(false)).isNull();
    }

    @ParameterizedTest
    @ValueSource(strings = {"DISCONNECT", "NATIVE_LOGIN"})
    void aSlowDesktopPatCannotPublishAfterDisconnectOrANewNativeLogin(String change) throws Exception {
        AccountService accounts = mock(AccountService.class);
        when(accounts.getOrCreateLocal(LOCAL_IDENTITY)).thenReturn(localAccount(7L));
        SecurityContextRepository sessions = mock(SecurityContextRepository.class);
        GithubConnectionCoordinator connections = new GithubConnectionCoordinator();
        var connection = connections.connection(7L);
        var desktopPat = new PatAuthService(githubApiClient, accounts, sessions, connections, DESKTOP);
        RestClient.Builder nativeBuilder = RestClient.builder();
        MockRestServiceServer nativeServer =
                MockRestServiceServer.bindTo(nativeBuilder).build();
        var nativeProperties = new GithubNativeOAuthProperties(
                "client-id",
                "https://github.test/login/device/code",
                "https://github.test/login/oauth/access_token",
                "",
                300);
        var nativeLogin = new GithubNativeOAuthService(
                nativeProperties,
                githubApiClient,
                accounts,
                nativeBuilder.build(),
                Clock.fixed(Instant.parse("2026-10-04T00:00:00Z"), ZoneOffset.UTC),
                connections);
        if (change.equals("NATIVE_LOGIN")) {
            nativeServer
                    .expect(requestTo(nativeProperties.deviceCodeUri()))
                    .andExpect(method(HttpMethod.POST))
                    .andRespond(withSuccess("""
                            {"device_code":"synthetic-new-device","user_code":"ABCD-EFGH",
                             "verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}
                            """, MediaType.APPLICATION_JSON));
        }
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        server.expect(requestTo(BASE_URL + "/user"))
                .andExpect(method(HttpMethod.GET))
                .andExpect(header(HttpHeaders.AUTHORIZATION, "Bearer synthetic-slow-pat"))
                .andRespond(providerRequest -> {
                    assertThat(connection.value).isEqualTo(1L);
                    assertThat(Thread.holdsLock(connection)).isFalse();
                    entered.countDown();
                    awaitRelease(release);
                    return withSuccess("""
                            {"id":42,"login":"octocat","name":"Octo Cat","avatar_url":null}
                            """, MediaType.APPLICATION_JSON).createResponse(providerRequest);
                });
        SecurityContext localContext = localContext(7L);
        var authentication = localContext.getAuthentication();
        MockHttpSession session = new MockHttpSession();
        session.setAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY, localContext);
        request.setSession(session);
        String sessionId = session.getId();
        try (var threads = Executors.newVirtualThreadPerTaskExecutor()) {
            var pending = threads.submit(() -> {
                SecurityContextHolder.setContext(localContext);
                try {
                    desktopPat.login("synthetic-slow-pat", request, response);
                    return null;
                } finally {
                    SecurityContextHolder.clearContext();
                }
            });
            try {
                assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                if (change.equals("DISCONNECT")) {
                    threads.submit(() -> nativeLogin.disconnect(7L)).get(5, TimeUnit.SECONDS);
                } else {
                    var start = threads.submit(() -> nativeLogin.start(7L)).get(5, TimeUnit.SECONDS);
                    assertThat(nativeLogin.poll(7L, start.attemptId()).status())
                            .isEqualTo(GithubNativeOAuthService.Status.WAITING);
                }
                assertThat(connection.value).isEqualTo(2L);
                release.countDown();
                assertThatThrownBy(() -> pending.get(5, TimeUnit.SECONDS))
                        .hasCauseInstanceOf(GithubReauthenticationRequiredException.class)
                        .satisfies(failure -> {
                            var problem = (GithubReauthenticationRequiredException) failure.getCause();
                            assertThat(problem.getBody().getProperties()).containsEntry("reason", "CONNECTION_CHANGED");
                            assertThat(problem.getCause()).isNull();
                            assertThat(problem.getMessage()).doesNotContain("synthetic-slow-pat");
                        });
            } finally {
                release.countDown();
            }
        }
        verify(accounts).getOrCreateLocal(LOCAL_IDENTITY);
        if (change.equals("DISCONNECT")) verify(accounts).disconnectGithub(7L);
        verifyNoMoreInteractions(accounts);
        verifyNoInteractions(sessions);
        assertThat(connection.value).isEqualTo(2L);
        assertThat(connections.connection(8L).value).isZero();
        assertThat(localContext.getAuthentication()).isSameAs(authentication);
        assertThat(request.getSession(false)).isSameAs(session);
        assertThat(session.getId()).isEqualTo(sessionId);
        assertThat(session.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY))
                .isSameAs(localContext);
        assertThat(response.getCookies()).isEmpty();
        server.verify();
        nativeServer.verify();
    }

    private static UserAccount localAccount(long id) {
        UserAccount account = UserAccount.local(LOCAL_IDENTITY);
        ReflectionTestUtils.setField(account, "id", id);
        return account;
    }

    private static SecurityContext localContext(long userId) {
        AuthenticatedUser principal =
                new AuthenticatedUser(userId, null, "local", "Local workspace", null, CredentialKind.LOCAL);
        SecurityContext context = SecurityContextHolder.createEmptyContext();
        context.setAuthentication(
                UsernamePasswordAuthenticationToken.authenticated(principal, null, principal.getAuthorities()));
        return context;
    }

    private static void awaitRelease(CountDownLatch release) throws IOException {
        try {
            if (!release.await(5, TimeUnit.SECONDS))
                throw new IOException("Synthetic profile response was not released");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException(interrupted);
        }
    }

    private void expectGithubUser() {
        HttpHeaders responseHeaders = new HttpHeaders();
        responseHeaders.add("X-OAuth-Scopes", "repo, read:user");
        server.expect(requestTo(BASE_URL + "/user"))
                .andRespond(withSuccess("""
                                {"id":42,"login":"octocat","name":"Octo Cat",
                                 "avatar_url":"https://avatars.test/octocat.png"}""", MediaType.APPLICATION_JSON).headers(responseHeaders));
    }
}
