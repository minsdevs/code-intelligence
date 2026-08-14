package dev.codeintelligence.auth;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.http.MediaType;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Caps unauthenticated {@code POST /api/auth/pat} attempts per client address so this app cannot
 * be used as an unbounded GitHub token-oracle.
 */
public final class PatLoginRateLimitFilter extends OncePerRequestFilter {

    private static final String PATH = "/api/auth/pat";
    private static final String BODY = "{\"type\":\"about:blank\",\"title\":\"Too Many Requests\",\"status\":429,"
            + "\"detail\":\"Too many PAT login attempts. Try again later.\"}";

    private final int maxAttempts;
    private final long windowMs;
    private final ConcurrentHashMap<String, Window> windows = new ConcurrentHashMap<>();

    public PatLoginRateLimitFilter(AuthProperties properties) {
        this.maxAttempts = properties.patLoginMaxAttempts();
        this.windowMs = properties.patLoginWindowMs();
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !("POST".equalsIgnoreCase(request.getMethod()) && PATH.equals(request.getServletPath()));
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String client = clientKey(request);
        if (!tryAcquire(client, System.currentTimeMillis())) {
            response.setStatus(429);
            response.setCharacterEncoding(StandardCharsets.UTF_8.name());
            response.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
            response.getWriter().write(BODY);
            return;
        }
        chain.doFilter(request, response);
    }

    boolean tryAcquire(String client, long nowMs) {
        Window next = windows.compute(client, (key, current) -> {
            if (current == null || nowMs - current.windowStartMs >= windowMs) {
                return new Window(1, nowMs);
            }
            return new Window(current.count + 1, current.windowStartMs);
        });
        return next.count <= maxAttempts;
    }

    static String clientKey(HttpServletRequest request) {
        String addr = request.getRemoteAddr();
        return addr == null || addr.isBlank() ? "unknown" : addr;
    }

    private record Window(int count, long windowStartMs) {}
}
