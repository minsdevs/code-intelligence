package dev.codeintelligence.ai;

import java.net.URI;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.ConstructorBinding;
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

    public List<String> models(String provider) {
        return switch (provider == null ? "" : provider.strip().toLowerCase(Locale.ROOT)) {
            case "openai" -> openai.supportedChatModels();
            case "gemini" -> gemini.supportedChatModels();
            default -> List.of();
        };
    }

    public boolean supportsModel(String provider, String model) {
        return model != null && models(provider).contains(model.strip());
    }

    public record OpenAi(
            @DefaultValue("") String apiKey,
            @DefaultValue("https://api.openai.com") String baseUrl,
            @DefaultValue("gpt-4o-mini") String chatModel,
            @DefaultValue("text-embedding-3-small") String embedModel,
            @DefaultValue("") String chatModels) {
        @ConstructorBinding
        public OpenAi {}

        public OpenAi(String apiKey, String baseUrl, String chatModel, String embedModel) {
            this(apiKey, baseUrl, chatModel, embedModel, "");
        }

        void validate() {
            if (StringUtils.hasText(baseUrl)) {
                AiHostAllowlist.validate(baseUrl);
            }
            validateModels(supportedChatModels());
        }

        List<String> supportedChatModels() {
            return modelList(chatModels, chatModel);
        }
    }

    public record Gemini(
            @DefaultValue("") String apiKey,

            @DefaultValue("https://generativelanguage.googleapis.com")
            String baseUrl,

            @DefaultValue("gemini-2.5-flash") String chatModel,
            @DefaultValue("gemini-embedding-001") String embedModel,
            @DefaultValue("") String chatModels) {
        @ConstructorBinding
        public Gemini {}

        public Gemini(String apiKey, String baseUrl, String chatModel, String embedModel) {
            this(apiKey, baseUrl, chatModel, embedModel, "");
        }

        void validate() {
            if (StringUtils.hasText(baseUrl)) {
                AiHostAllowlist.validate(baseUrl);
            }
            validateModels(supportedChatModels());
        }

        List<String> supportedChatModels() {
            return modelList(chatModels, chatModel);
        }
    }

    private static List<String> modelList(String configured, String defaultModel) {
        LinkedHashSet<String> models = new LinkedHashSet<>();
        if (configured != null) {
            Arrays.stream(configured.split(","))
                    .map(String::strip)
                    .filter(StringUtils::hasText)
                    .forEach(models::add);
        }
        if (StringUtils.hasText(defaultModel)) {
            models.add(defaultModel.strip());
        }
        return List.copyOf(models);
    }

    private static void validateModels(List<String> models) {
        if (models.stream().anyMatch(model -> !model.matches("[A-Za-z0-9._:-]{1,200}"))) {
            throw new IllegalStateException("app.ai chat model ids must contain only safe model characters");
        }
    }

    static final class AiHostAllowlist {
        private static final Set<String> REMOTE_HOSTS = Set.of("api.openai.com", "generativelanguage.googleapis.com");
        private static final Set<String> LOOPBACK_HOSTS = Set.of("localhost", "127.0.0.1", "::1", "[::1]");

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
            String normalizedHost = host.toLowerCase(Locale.ROOT);
            if (LOOPBACK_HOSTS.contains(normalizedHost)) {
                return;
            }
            if (REMOTE_HOSTS.contains(normalizedHost)) {
                if (!"https".equals(scheme)) {
                    throw new IllegalStateException("app.ai remote base-url must use https");
                }
                return;
            }
            throw new IllegalStateException("app.ai base-url host is not allowed");
        }
    }
}
