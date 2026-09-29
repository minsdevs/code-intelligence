package dev.codeintelligence.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import dev.codeintelligence.common.security.AuthenticatedUser;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.context.SecurityContextHolder;

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

    private MockHttpServletRequest requestWithToken() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader(DesktopAuthenticationFilter.TOKEN_HEADER, TOKEN);
        return request;
    }
}
