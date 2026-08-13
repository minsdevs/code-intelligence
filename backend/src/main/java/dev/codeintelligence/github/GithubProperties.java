package dev.codeintelligence.github;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

@ConfigurationProperties("app.github")
public record GithubProperties(
        @DefaultValue("https://api.github.com") String baseUrl) {}
