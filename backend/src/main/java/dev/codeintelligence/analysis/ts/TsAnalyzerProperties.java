package dev.codeintelligence.analysis.ts;

import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.util.Locale;
import java.util.Set;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.ConstructorBinding;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.util.StringUtils;

/**
 * Sidecar connection. Blank {@code base-url} disables {@code TS_PARSING}. Development HTTP uses
 * a loopback/compose SSRF allowlist. HTTPS requires a literal loopback origin, exact certificate
 * fingerprint and caller token supplied out of band.
 */
@ConfigurationProperties("app.ts-analyzer")
public record TsAnalyzerProperties(
        @DefaultValue("") String baseUrl,
        @DefaultValue("30") int timeoutSeconds,
        @DefaultValue("") String tlsCertSha256,
        @DefaultValue("") String authToken) {

    private static final Set<String> ALLOWED_HOSTS = Set.of("localhost", "127.0.0.1", "::1", "ts-analyzer");

    public TsAnalyzerProperties(String baseUrl, int timeoutSeconds) {
        this(baseUrl, timeoutSeconds, "", "");
    }

    @ConstructorBinding
    public TsAnalyzerProperties {
        if (timeoutSeconds < 1) {
            throw new IllegalStateException("app.ts-analyzer.timeout-seconds must be at least 1");
        }
        if (StringUtils.hasText(baseUrl)) {
            baseUrl = stripTrailingSlash(baseUrl.strip());
        } else {
            baseUrl = "";
        }
        tlsCertSha256 = tlsCertSha256 == null ? "" : tlsCertSha256;
        authToken = authToken == null ? "" : authToken;
        boolean tlsConfigured = !tlsCertSha256.isEmpty() || !authToken.isEmpty();
        URI uri;
        try {
            uri = URI.create(baseUrl);
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException("app.ts-analyzer.base-url is not a valid URI");
        }
        boolean https = "https".equalsIgnoreCase(uri.getScheme());
        if (tlsConfigured || https) {
            if (!tlsCertSha256.matches("[0-9a-fA-F]{64}") || !authToken.matches("[0-9a-fA-F]{64}")) {
                throw new IllegalStateException("ts-analyzer TLS requires a SHA-256 certificate pin and caller token");
            }
            if (!"https".equals(uri.getScheme())
                    || !("127.0.0.1".equals(uri.getHost()) || "[::1]".equals(uri.getHost()))
                    || uri.getPort() < 1
                    || uri.getPort() > 65535
                    || uri.getRawUserInfo() != null
                    || uri.getRawQuery() != null
                    || uri.getRawFragment() != null
                    || (uri.getRawPath() != null && !uri.getRawPath().isEmpty())) {
                throw new IllegalStateException(
                        "ts-analyzer TLS requires an HTTPS literal loopback origin with an explicit port");
            }
            tlsCertSha256 = tlsCertSha256.toLowerCase(Locale.ROOT);
        } else if (!baseUrl.isEmpty()) {
            validate(baseUrl);
        }
    }

    public boolean pinnedTls() {
        return !tlsCertSha256.isEmpty();
    }

    // Configuration records otherwise expose caller capabilities through their generated toString().
    @Override
    public String toString() {
        return "TsAnalyzerProperties[enabled=" + enabled() + ", timeoutSeconds=" + timeoutSeconds + ", pinnedTls="
                + pinnedTls() + "]";
    }

    public boolean enabled() {
        return StringUtils.hasText(baseUrl);
    }

    static void validate(String raw) {
        URI uri;
        try {
            uri = URI.create(raw);
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException("app.ts-analyzer.base-url is not a valid URI");
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            throw new IllegalStateException("app.ts-analyzer.base-url must be http or https");
        }
        if (uri.getUserInfo() != null) {
            throw new IllegalStateException("app.ts-analyzer.base-url must not include userinfo");
        }
        String host = uri.getHost();
        if (host == null || host.isBlank()) {
            throw new IllegalStateException("app.ts-analyzer.base-url must include a host");
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
            throw new IllegalStateException("app.ts-analyzer.base-url host is not allowed");
        }
        throw new IllegalStateException("app.ts-analyzer.base-url host is not allowed");
    }

    private static String stripTrailingSlash(String url) {
        if (url.endsWith("/")) {
            return url.substring(0, url.length() - 1);
        }
        return url;
    }
}
