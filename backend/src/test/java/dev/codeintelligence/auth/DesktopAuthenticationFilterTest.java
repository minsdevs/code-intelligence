package dev.codeintelligence.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

import dev.codeintelligence.common.security.AuthenticatedUser;
import dev.codeintelligence.common.security.CredentialKind;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;

class DesktopAuthenticationFilterTest {

    private static final String TOKEN = "launch-token";
    private static final String ORIGIN = "http://127.0.0.1:4311";

    private final AccountService accounts = mock(AccountService.class);
    private final UserAccount localAccount = mock(UserAccount.class);
    private final DesktopAuthenticationFilter filter =
            new DesktopAuthenticationFilter(new DesktopAuthProperties(TOKEN, "local-key", ORIGIN), accounts);

    @AfterEach
    void clearSecurityContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void acceptsAnExactOrigin() throws Exception {
        when(localAccount.getId()).thenReturn(7L);
        when(localAccount.getLogin()).thenReturn("local");
        when(localAccount.getName()).thenReturn("Local workspace");
        when(accounts.getOrCreateLocal("local-key")).thenReturn(localAccount);
        MockHttpServletRequest request = requestWithToken();
        request.addHeader("Origin", ORIGIN);
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicBoolean continued = new AtomicBoolean();

        filter.doFilter(request, response, (req, res) -> continued.set(true));

        assertThat(response.getStatus()).isEqualTo(200);
        assertThat(continued).isTrue();
        assertThat(SecurityContextHolder.getContext().getAuthentication().getPrincipal())
                .isInstanceOf(AuthenticatedUser.class);
        verify(accounts).getOrCreateLocal("local-key");
    }

    @Test
    void acceptsAnExactRefererOrigin() throws Exception {
        when(localAccount.getId()).thenReturn(7L);
        when(localAccount.getLogin()).thenReturn("local");
        when(localAccount.getName()).thenReturn("Local workspace");
        when(accounts.getOrCreateLocal("local-key")).thenReturn(localAccount);
        MockHttpServletRequest request = requestWithToken();
        request.addHeader("Referer", ORIGIN + "/settings?tab=desktop");
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicBoolean continued = new AtomicBoolean();

        filter.doFilter(request, response, (req, res) -> continued.set(true));

        assertThat(response.getStatus()).isEqualTo(200);
        assertThat(continued).isTrue();
        verify(accounts).getOrCreateLocal("local-key");
    }

    @Test
    void rejectsForeignPrefixConfusionAndMalformedOriginsWithoutInvokingDownstream() throws Exception {
        for (String origin :
                new String[] {"http://127.0.0.1:4312", "http://127.0.0.1:4311.evil.example", "not-an-origin"}) {
            MockHttpServletRequest request = requestWithToken();
            request.addHeader("Origin", origin);
            MockHttpServletResponse response = new MockHttpServletResponse();
            var chain = mock(jakarta.servlet.FilterChain.class);

            filter.doFilter(request, response, chain);

            assertThat(response.getStatus()).as(origin).isEqualTo(403);
            verifyNoInteractions(accounts, chain);
        }
    }

    @Test
    void rejectsCrossSiteFetchMetadataWithoutOriginOrReferer() throws Exception {
        MockHttpServletRequest request = requestWithToken();
        request.addHeader("Sec-Fetch-Site", "cross-site");
        MockHttpServletResponse response = new MockHttpServletResponse();
        var chain = mock(jakarta.servlet.FilterChain.class);

        filter.doFilter(request, response, chain);

        assertThat(response.getStatus()).isEqualTo(403);
        verifyNoInteractions(accounts, chain);
    }

    @Test
    void allowsElectronInternalFetchWhenBrowserMetadataIsAbsent() throws Exception {
        when(localAccount.getId()).thenReturn(7L);
        when(localAccount.getLogin()).thenReturn("local");
        when(localAccount.getName()).thenReturn("Local workspace");
        when(accounts.getOrCreateLocal("local-key")).thenReturn(localAccount);
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicBoolean continued = new AtomicBoolean();

        filter.doFilter(requestWithToken(), response, (req, res) -> continued.set(true));

        assertThat(response.getStatus()).isEqualTo(200);
        assertThat(continued).isTrue();
        verify(accounts).getOrCreateLocal("local-key");
    }

    @Test
    void failsClosedWhenAnyDesktopSettingIsMissing() throws Exception {
        DesktopAuthenticationFilter unconfigured =
                new DesktopAuthenticationFilter(new DesktopAuthProperties(TOKEN, "local-key", ""), accounts);
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicBoolean continued = new AtomicBoolean();

        unconfigured.doFilter(requestWithToken(), response, (req, res) -> continued.set(true));

        assertThat(response.getStatus()).isEqualTo(200);
        assertThat(continued).isTrue();
        verifyNoInteractions(accounts);
    }

    @Test
    void keepsExistingAuthenticationFlowForMissingOrInvalidTokens() throws Exception {
        for (String token : new String[] {null, "wrong-token"}) {
            MockHttpServletRequest request = new MockHttpServletRequest();
            if (token != null) request.addHeader(DesktopAuthenticationFilter.TOKEN_HEADER, token);
            MockHttpServletResponse response = new MockHttpServletResponse();
            AtomicBoolean continued = new AtomicBoolean();

            filter.doFilter(request, response, (req, res) -> continued.set(true));

            assertThat(response.getStatus()).isEqualTo(200);
            assertThat(continued).isTrue();
        }
        verifyNoInteractions(accounts);
    }

    @Test
    void acceptsHttpsOriginAndCapabilityBackedFirstDocument() throws Exception {
        DesktopAuthenticationFilter https = new DesktopAuthenticationFilter(
                new DesktopAuthProperties(TOKEN, "local-key", "https://127.0.0.1:4311"), accounts);
        when(localAccount.getId()).thenReturn(7L);
        when(localAccount.getLogin()).thenReturn("local");
        when(accounts.getOrCreateLocal("local-key")).thenReturn(localAccount);
        MockHttpServletRequest first = requestWithToken();
        first.setMethod("GET");
        first.addHeader("Sec-Fetch-Site", "none");
        first.addHeader("Sec-Fetch-Mode", "navigate");
        first.addHeader("Sec-Fetch-Dest", "document");
        AtomicBoolean continued = new AtomicBoolean();
        https.doFilter(first, new MockHttpServletResponse(), (req, res) -> continued.set(true));
        assertThat(continued).isTrue();
        MockHttpServletRequest sameOrigin = requestWithToken();
        sameOrigin.addHeader("Origin", "https://127.0.0.1:4311");
        https.doFilter(sameOrigin, new MockHttpServletResponse(), (req, res) -> {});
        MockHttpServletRequest downgrade = requestWithToken();
        downgrade.addHeader("Origin", ORIGIN);
        MockHttpServletResponse rejected = new MockHttpServletResponse();
        https.doFilter(downgrade, rejected, (req, res) -> {
            throw new AssertionError("HTTP origin accepted");
        });
        assertThat(rejected.getStatus()).isEqualTo(403);
    }

    @ParameterizedTest
    @EnumSource(
            value = CredentialKind.class,
            names = {"PAT", "OAUTH", "LOCAL"})
    void validLaunchCapabilityReplacesAStaleSessionPrincipalWithTheInstallationLocalOwner(CredentialKind previousKind)
            throws Exception {
        when(localAccount.getId()).thenReturn(7L);
        when(localAccount.getGithubId()).thenReturn(42L);
        when(localAccount.getLogin()).thenReturn("installed-owner");
        when(localAccount.getName()).thenReturn("Installation owner");
        when(localAccount.getAvatarUrl()).thenReturn("https://avatars.test/installed-owner.png");
        when(accounts.getOrCreateLocal("local-key")).thenReturn(localAccount);
        AuthenticatedUser stale =
                new AuthenticatedUser(99L, 9001L, "previous-browser-user", "Previous browser user", null, previousKind);
        SecurityContext saved = SecurityContextHolder.createEmptyContext();
        saved.setAuthentication(UsernamePasswordAuthenticationToken.authenticated(stale, null, stale.getAuthorities()));
        MockHttpSession session = new MockHttpSession();
        session.setAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY, saved);
        String sessionId = session.getId();
        MockHttpServletRequest request = requestWithToken();
        request.addHeader("Origin", ORIGIN);
        request.setSession(session);
        // Load the previous session before invoking the real desktop authentication filter.
        var repository = new HttpSessionSecurityContextRepository();
        SecurityContextHolder.setContext(repository.loadDeferredContext(request).get());
        assertThat(SecurityContextHolder.getContext().getAuthentication().getPrincipal())
                .isSameAs(stale);
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicBoolean continued = new AtomicBoolean();
        AuthenticatedUser expected = new AuthenticatedUser(
                7L,
                42L,
                "installed-owner",
                "Installation owner",
                "https://avatars.test/installed-owner.png",
                CredentialKind.LOCAL);

        filter.doFilter(request, response, (req, res) -> {
            continued.set(true);
            var authentication = SecurityContextHolder.getContext().getAuthentication();
            assertThat(authentication.isAuthenticated()).isTrue();
            assertThat(authentication.getPrincipal()).isEqualTo(expected);
            assertThat(authentication.getAuthorities()).isEqualTo(expected.getAuthorities());
            assertThat(authentication.getCredentials()).isNull();
        });

        assertThat(response.getStatus()).isEqualTo(200);
        assertThat(continued).isTrue();
        assertThat(SecurityContextHolder.getContext().getAuthentication().getPrincipal())
                .isEqualTo(expected);
        assertThat(request.getSession(false)).isSameAs(session);
        assertThat(session.getId()).isEqualTo(sessionId);
        verify(accounts).getOrCreateLocal("local-key");
        verifyNoMoreInteractions(accounts);
    }

    @ParameterizedTest
    @ValueSource(strings = {"MISSING", "INVALID"})
    void missingOrInvalidLaunchCapabilityDoesNotRebindAnExistingBrowserSession(String mode) throws Exception {
        AuthenticatedUser browser = new AuthenticatedUser(99L, 9001L, "browser-user", null, null, CredentialKind.PAT);
        SecurityContext saved = SecurityContextHolder.createEmptyContext();
        saved.setAuthentication(
                UsernamePasswordAuthenticationToken.authenticated(browser, null, browser.getAuthorities()));
        MockHttpSession session = new MockHttpSession();
        session.setAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY, saved);
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setSession(session);
        request.addHeader("Origin", ORIGIN);
        if (mode.equals("INVALID"))
            request.addHeader(DesktopAuthenticationFilter.TOKEN_HEADER, "previous-launch-token");
        var repository = new HttpSessionSecurityContextRepository();
        SecurityContextHolder.setContext(repository.loadDeferredContext(request).get());
        var before = SecurityContextHolder.getContext().getAuthentication();
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicBoolean continued = new AtomicBoolean();

        filter.doFilter(request, response, (req, res) -> {
            continued.set(true);
            assertThat(SecurityContextHolder.getContext().getAuthentication()).isSameAs(before);
        });

        assertThat(continued).isTrue();
        assertThat(SecurityContextHolder.getContext().getAuthentication().getPrincipal())
                .isSameAs(browser);
        assertThat(session.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY))
                .isSameAs(saved);
        verifyNoInteractions(accounts);
    }

    private MockHttpServletRequest requestWithToken() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader(DesktopAuthenticationFilter.TOKEN_HEADER, TOKEN);
        return request;
    }
}
