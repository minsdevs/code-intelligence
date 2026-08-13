package dev.codeintelligence.auth;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("app")
public record TokenCryptoProperties(String tokenEncKey) {}
