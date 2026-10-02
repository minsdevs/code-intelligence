package dev.codeintelligence.auth;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.util.StringUtils;

@ConfigurationProperties("app.desktop")
public record DesktopAuthProperties(String apiToken, String localIdentity, String allowedOrigin) {

    public boolean configured() {
        return StringUtils.hasText(apiToken)
                && StringUtils.hasText(localIdentity)
                && StringUtils.hasText(allowedOrigin);
    }
}
