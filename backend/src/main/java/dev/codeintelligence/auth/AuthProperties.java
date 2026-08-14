package dev.codeintelligence.auth;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

@ConfigurationProperties("app.auth")
public record AuthProperties(
        @DefaultValue("20") int patLoginMaxAttempts,
        @DefaultValue("60") int patLoginWindowSeconds) {

    public AuthProperties {
        if (patLoginMaxAttempts < 1) {
            throw new IllegalStateException("app.auth.pat-login-max-attempts must be at least 1");
        }
        if (patLoginWindowSeconds < 1) {
            throw new IllegalStateException("app.auth.pat-login-window-seconds must be at least 1");
        }
    }

    public long patLoginWindowMs() {
        return patLoginWindowSeconds * 1000L;
    }
}
