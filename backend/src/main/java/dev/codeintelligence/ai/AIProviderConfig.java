package dev.codeintelligence.ai;

import java.util.Locale;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.json.JsonMapper;

@Configuration
public class AIProviderConfig {

    @Bean
    AIProviderFactory aiProviderFactory(
            AiProperties properties, RestClient.Builder restClientBuilder, JsonMapper json) {
        return (provider, apiKey, model) -> switch (provider == null
                ? ""
                : provider.strip().toLowerCase(Locale.ROOT)) {
            case "openai" -> new OpenAIProvider(properties.openai(), restClientBuilder, json, apiKey, model);
            case "gemini" -> new GeminiProvider(properties.gemini(), restClientBuilder, json, apiKey, model);
            default -> new NoOpAIProvider();
        };
    }

    @Bean
    AIProviderResolver aiProviderResolver(
            AiProperties properties, AiSettingsService settings, AIProviderFactory factory) {
        return new RuntimeAIProvider(properties, settings, factory);
    }

    /**
     * Picks the key at call time: a key saved from the Settings screen wins, otherwise the
     * env-configured key. Saving/clearing a key therefore takes effect without a restart.
     */
    static final class RuntimeAIProvider implements AIProviderResolver {

        private final AiProperties env;
        private final AiSettingsService settings;
        private final AIProviderFactory factory;

        RuntimeAIProvider(AiProperties env, AiSettingsService settings, AIProviderFactory factory) {
            this.env = env;
            this.settings = settings;
            this.factory = factory;
        }

        @Override
        public AIProvider resolve(long userId) {
            var stored = settings.getKey(userId);
            if (stored.isPresent()) {
                AiSettingsService.StoredKey key = stored.get();
                AIProvider provider = factory.create(key.provider(), key.apiKey(), key.model());
                if (provider.enabled()) {
                    return provider;
                }
            }
            return switch (env.resolvedProvider()) {
                case "openai" -> env.configured() ? factory.create("openai", null, null) : new NoOpAIProvider();
                case "gemini" -> env.configured() ? factory.create("gemini", null, null) : new NoOpAIProvider();
                default -> new NoOpAIProvider();
            };
        }
    }
}
