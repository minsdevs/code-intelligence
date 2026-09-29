package dev.codeintelligence.auth;

import dev.codeintelligence.common.security.AuthenticatedUser;
import dev.codeintelligence.common.security.CredentialKind;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.util.StringUtils;
import org.springframework.web.filter.OncePerRequestFilter;

/** Authenticates only requests carrying the per-launch secret injected by the desktop preload. */
public final class DesktopAuthenticationFilter extends OncePerRequestFilter {

    public static final String TOKEN_HEADER = "X-Code-Intelligence-Token";

    private final DesktopAuthProperties properties;
    private final AccountService accountService;

    public DesktopAuthenticationFilter(DesktopAuthProperties properties, AccountService accountService) {
        this.properties = properties;
        this.accountService = accountService;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (properties.configured() && tokenMatches(request.getHeader(TOKEN_HEADER))) {
            if (!requestOriginAllowed(request)) {
                response.sendError(HttpServletResponse.SC_FORBIDDEN);
                return;
            }
            if (SecurityContextHolder.getContext().getAuthentication() == null) {
                UserAccount account = accountService.getOrCreateLocal(properties.localIdentity());
                AuthenticatedUser principal = new AuthenticatedUser(
                        account.getId(),
                        account.getGithubId(),
                        account.getLogin(),
                        account.getName(),
                        account.getAvatarUrl(),
                        CredentialKind.LOCAL);
                SecurityContextHolder.getContext()
                        .setAuthentication(UsernamePasswordAuthenticationToken.authenticated(
                                principal, null, principal.getAuthorities()));
            }
        }
        chain.doFilter(request, response);
    }

    private boolean requestOriginAllowed(HttpServletRequest request) {
        String origin = request.getHeader("Origin");
        if (origin != null) {
            return sameOrigin(origin, properties.allowedOrigin(), true);
        }

        String referer = request.getHeader("Referer");
        if (referer != null) {
            return sameOrigin(referer, properties.allowedOrigin(), false);
        }

        String fetchSite = request.getHeader("Sec-Fetch-Site");
        return fetchSite == null || "same-origin".equals(fetchSite.trim().toLowerCase(Locale.ROOT));
    }

    private boolean sameOrigin(String candidate, String expected, boolean originHeader) {
        try {
            URI candidateUri = URI.create(candidate.trim());
            URI expectedUri = URI.create(expected.trim());
            if (originHeader
                    && (candidateUri.getRawPath() != null
                                    && !candidateUri.getRawPath().isEmpty()
                            || candidateUri.getRawQuery() != null
                            || candidateUri.getRawFragment() != null)) {
                return false;
            }
            if (candidateUri.getScheme() == null
                    || candidateUri.getHost() == null
                    || candidateUri.getRawUserInfo() != null
                    || expectedUri.getScheme() == null
                    || expectedUri.getHost() == null
                    || expectedUri.getRawUserInfo() != null
                    || expectedUri.getRawPath() != null
                            && !expectedUri.getRawPath().isEmpty()
                    || expectedUri.getRawQuery() != null
                    || expectedUri.getRawFragment() != null) {
                return false;
            }
            return candidateUri.getScheme().equalsIgnoreCase(expectedUri.getScheme())
                    && candidateUri.getHost().equalsIgnoreCase(expectedUri.getHost())
                    && effectivePort(candidateUri) == effectivePort(expectedUri);
        } catch (IllegalArgumentException ex) {
            return false;
        }
    }

    private int effectivePort(URI uri) {
        if (uri.getPort() >= 0) {
            return uri.getPort();
        }
        return switch (uri.getScheme().toLowerCase(Locale.ROOT)) {
            case "http" -> 80;
            case "https" -> 443;
            default -> -1;
        };
    }

    private boolean tokenMatches(String candidate) {
        if (!StringUtils.hasText(candidate)) {
            return false;
        }
        return MessageDigest.isEqual(
                properties.apiToken().getBytes(StandardCharsets.UTF_8), candidate.getBytes(StandardCharsets.UTF_8));
    }
}
