package dev.codeintelligence.github;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/** cloneBaseUrl exists for tests (file:// fixtures); user-facing input is still RepoRef-validated. */
@ConfigurationProperties("app.github")
public record GithubProperties(
        @DefaultValue("https://api.github.com") String baseUrl,
        @DefaultValue("https://github.com") String cloneBaseUrl) {}
