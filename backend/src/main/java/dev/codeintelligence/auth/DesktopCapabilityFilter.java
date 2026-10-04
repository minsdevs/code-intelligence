package dev.codeintelligence.auth;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.web.filter.GenericFilterBean;

/** Launch capability gate, registered before Spring Session and Spring Security in desktop mode. */
public final class DesktopCapabilityFilter extends GenericFilterBean {

    private final byte[] token;
    private final String allowedOrigin;

    public DesktopCapabilityFilter(DesktopAuthProperties properties) {
        this.token = properties.apiToken().getBytes(StandardCharsets.UTF_8);
        this.allowedOrigin = properties.allowedOrigin();
    }

    @Override
    public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
            throws IOException, ServletException {
        HttpServletRequest http = (HttpServletRequest) request;
        HttpServletResponse result = (HttpServletResponse) response;
        var headers = http.getHeaders(DesktopAuthenticationFilter.TOKEN_HEADER);
        String provided = headers.hasMoreElements() ? headers.nextElement() : null;
        if (!http.isSecure()
                || provided == null
                || headers.hasMoreElements()
                || !MessageDigest.isEqual(token, provided.getBytes(StandardCharsets.UTF_8))) {
            result.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            result.setHeader("Cache-Control", "no-store");
            return;
        }
        if (!DesktopAuthenticationFilter.requestOriginAllowed(http, allowedOrigin)) {
            result.setStatus(HttpServletResponse.SC_FORBIDDEN);
            result.setHeader("Cache-Control", "no-store");
            return;
        }
        chain.doFilter(request, response);
    }
}
