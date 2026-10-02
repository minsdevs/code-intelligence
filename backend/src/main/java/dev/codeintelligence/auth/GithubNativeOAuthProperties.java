package dev.codeintelligence.auth;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.util.StringUtils;

@ConfigurationProperties("app.github.native-oauth")
public record GithubNativeOAuthProperties(
        String clientId,

        @DefaultValue("https://github.com/login/oauth/authorize")
        String authorizationUri,

        @DefaultValue("https://github.com/login/oauth/access_token")
        String tokenUri,

        @DefaultValue("http://127.0.0.1:8080/api/auth/github/native/callback")
        String redirectUri,

        @DefaultValue("300") int attemptTtlSeconds) {

    public GithubNativeOAuthProperties {
        if (attemptTtlSeconds < 30 || attemptTtlSeconds > 900) {
            throw new IllegalStateException("app.github.native-oauth.attempt-ttl-seconds must be between 30 and 900");
        }
    }

    public boolean configured() {
        return StringUtils.hasText(clientId);
    }
}
