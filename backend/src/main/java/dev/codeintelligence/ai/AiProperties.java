package dev.codeintelligence.ai;

import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.util.Locale;
import java.util.Set;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.util.StringUtils;

@ConfigurationProperties("app.ai")
public record AiProperties(
        @DefaultValue("") String provider,
        @DefaultValue("8000") int maxContextTokens,
        @DefaultValue("500000") int dailyTokenLimit,
        @DefaultValue("40") int focusLineWindow,
        OpenAi openai,
        Gemini gemini) {

    public AiProperties {
        if (maxContextTokens < 256) {
            throw new IllegalStateException("app.ai.max-context-tokens must be at least 256");
        }
        if (dailyTokenLimit < 1) {
            throw new IllegalStateException("app.ai.daily-token-limit must be at least 1");
        }
        if (focusLineWindow < 1) {
            throw new IllegalStateException("app.ai.focus-line-window must be at least 1");
        }
        if (openai == null) {
            openai = new OpenAi("", "", "", "");
        }
        if (gemini == null) {
            gemini = new Gemini("", "", "", "");
        }
        openai.validate();
        gemini.validate();
    }

    public boolean configured() {
        return switch (resolvedProvider()) {
            case "openai" -> StringUtils.hasText(openai.apiKey());
            case "gemini" -> StringUtils.hasText(gemini.apiKey());
            default -> false;
        };
    }

    public String resolvedProvider() {
        if (StringUtils.hasText(provider)) {
            return provider.strip().toLowerCase(Locale.ROOT);
        }
        if (StringUtils.hasText(openai.apiKey())) {
            return "openai";
        }
        if (StringUtils.hasText(gemini.apiKey())) {
            return "gemini";
        }
        return "";
    }

    public record OpenAi(
            @DefaultValue("") String apiKey,
            @DefaultValue("https://api.openai.com") String baseUrl,
            @DefaultValue("gpt-4o-mini") String chatModel,
            @DefaultValue("text-embedding-3-small") String embedModel) {
        void validate() {
            if (StringUtils.hasText(apiKey)) {
                AiHostAllowlist.validate(baseUrl);
            }
        }
    }

    public record Gemini(
            @DefaultValue("") String apiKey,

            @DefaultValue("https://generativelanguage.googleapis.com")
            String baseUrl,

            @DefaultValue("gemini-2.0-flash") String chatModel,
            @DefaultValue("text-embedding-004") String embedModel) {
        void validate() {
            if (StringUtils.hasText(apiKey)) {
                AiHostAllowlist.validate(baseUrl);
            }
        }
    }

    static final class AiHostAllowlist {
        private static final Set<String> ALLOWED =
                Set.of("api.openai.com", "generativelanguage.googleapis.com", "localhost", "127.0.0.1", "::1");

        private AiHostAllowlist() {}

        static void validate(String raw) {
            URI uri;
            try {
                uri = URI.create(raw);
            } catch (IllegalArgumentException e) {
                throw new IllegalStateException("app.ai base-url is not a valid URI");
            }
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!"http".equals(scheme) && !"https".equals(scheme)) {
                throw new IllegalStateException("app.ai base-url must be http or https");
            }
            if (uri.getUserInfo() != null) {
                throw new IllegalStateException("app.ai base-url must not include userinfo");
            }
            String host = uri.getHost();
            if (host == null || host.isBlank()) {
                throw new IllegalStateException("app.ai base-url must include a host");
            }
            if (ALLOWED.contains(host.toLowerCase(Locale.ROOT))) {
                return;
            }
            try {
                if (InetAddress.getByName(host).isLoopbackAddress()) {
                    return;
                }
            } catch (UnknownHostException e) {
                throw new IllegalStateException("app.ai base-url host is not allowed");
            }
            throw new IllegalStateException("app.ai base-url host is not allowed");
        }
    }
}
