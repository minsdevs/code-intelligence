package dev.codeintelligence.common.config;

import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/** §18 carry-over ③: explicit allowlist only — wildcard origins must never pair with credentials. */
@ConfigurationProperties("app.cors")
public record CorsProperties(
        @DefaultValue("http://localhost:5173") List<String> allowedOrigins) {

    public CorsProperties {
        if (allowedOrigins == null || allowedOrigins.isEmpty()) {
            throw new IllegalStateException("app.cors.allowed-origins must contain at least one origin");
        }
        if (allowedOrigins.stream().anyMatch(origin -> origin.contains("*"))) {
            throw new IllegalStateException(
                    "app.cors.allowed-origins must not contain wildcards (allowCredentials=true)");
        }
    }

    /** OAuth login lands here after the callback. */
    public String frontendOrigin() {
        return allowedOrigins.get(0);
    }
}
