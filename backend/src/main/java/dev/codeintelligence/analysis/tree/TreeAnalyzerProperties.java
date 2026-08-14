package dev.codeintelligence.analysis.tree;

import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.util.Locale;
import java.util.Set;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.util.StringUtils;

/**
 * Sidecar connection for the tree-sitter analyzer (Python/Go/Vue/Svelte). Blank
 * {@code base-url} disables the step; a set URL must be http(s) to loopback or the
 * compose service name {@code tree-analyzer} (SSRF allowlist).
 */
@ConfigurationProperties("app.tree-analyzer")
public record TreeAnalyzerProperties(
        @DefaultValue("") String baseUrl,
        @DefaultValue("30") int timeoutSeconds) {

    private static final Set<String> ALLOWED_HOSTS = Set.of("localhost", "127.0.0.1", "::1", "tree-analyzer");

    public TreeAnalyzerProperties {
        if (timeoutSeconds < 1) {
            throw new IllegalStateException("app.tree-analyzer.timeout-seconds must be at least 1");
        }
        if (StringUtils.hasText(baseUrl)) {
            validate(baseUrl.strip());
            baseUrl = stripTrailingSlash(baseUrl.strip());
        } else {
            baseUrl = "";
        }
    }

    public boolean enabled() {
        return StringUtils.hasText(baseUrl);
    }

    static void validate(String raw) {
        URI uri;
        try {
            uri = URI.create(raw);
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException("app.tree-analyzer.base-url is not a valid URI");
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            throw new IllegalStateException("app.tree-analyzer.base-url must be http or https");
        }
        if (uri.getUserInfo() != null) {
            throw new IllegalStateException("app.tree-analyzer.base-url must not include userinfo");
        }
        String host = uri.getHost();
        if (host == null || host.isBlank()) {
            throw new IllegalStateException("app.tree-analyzer.base-url must include a host");
        }
        if (ALLOWED_HOSTS.contains(host.toLowerCase(Locale.ROOT))) {
            return;
        }
        try {
            InetAddress address = InetAddress.getByName(host);
            if (address.isLoopbackAddress()) {
                return;
            }
        } catch (UnknownHostException e) {
            throw new IllegalStateException("app.tree-analyzer.base-url host is not allowed");
        }
        throw new IllegalStateException("app.tree-analyzer.base-url host is not allowed");
    }

    private static String stripTrailingSlash(String url) {
        if (url.endsWith("/")) {
            return url.substring(0, url.length() - 1);
        }
        return url;
    }
}
