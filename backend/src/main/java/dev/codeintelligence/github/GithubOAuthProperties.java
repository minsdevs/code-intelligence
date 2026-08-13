package dev.codeintelligence.github;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.util.StringUtils;

/** Blank values mean the OAuth App is not configured; PAT login remains fully functional. */
@ConfigurationProperties("app.github.oauth")
public record GithubOAuthProperties(String clientId, String clientSecret) {

    public boolean configured() {
        return StringUtils.hasText(clientId) && StringUtils.hasText(clientSecret);
    }
}
