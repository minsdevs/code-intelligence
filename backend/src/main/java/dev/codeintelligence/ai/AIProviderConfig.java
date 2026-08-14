package dev.codeintelligence.ai;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.json.JsonMapper;

@Configuration
public class AIProviderConfig {

    @Bean
    AIProvider aiProvider(
            AiProperties properties,
            AiSettingsService settings,
            RestClient.Builder restClientBuilder,
            JsonMapper json) {
        return new RuntimeAIProvider(properties, settings, restClientBuilder, json);
    }

    /**
     * Picks the key at call time: a key saved from the Settings screen wins, otherwise the
     * env-configured key. Saving/clearing a key therefore takes effect without a restart.
     */
    static final class RuntimeAIProvider implements AIProvider {

        private final AiProperties env;
        private final AiSettingsService settings;
        private final RestClient.Builder restClientBuilder;
        private final JsonMapper json;

        RuntimeAIProvider(
                AiProperties env, AiSettingsService settings, RestClient.Builder restClientBuilder, JsonMapper json) {
            this.env = env;
            this.settings = settings;
            this.restClientBuilder = restClientBuilder;
            this.json = json;
        }

        private synchronized AIProvider delegate() {
            var stored = settings.latestKey();
            if (stored.isPresent()) {
                AiSettingsService.StoredKey key = stored.get();
                if ("openai".equals(key.provider())) {
                    OpenAIProvider provider = new OpenAIProvider(env.openai(), restClientBuilder, json, key.apiKey());
                    if (provider.hasKey()) {
                        return provider;
                    }
                }
                if ("gemini".equals(key.provider())) {
                    GeminiProvider provider = new GeminiProvider(env.gemini(), restClientBuilder, json, key.apiKey());
                    if (provider.hasKey()) {
                        return provider;
                    }
                }
            }
            return switch (env.resolvedProvider()) {
                case "openai" ->
                    env.configured()
                            ? new OpenAIProvider(env.openai(), restClientBuilder, json, null)
                            : new NoOpAIProvider();
                case "gemini" ->
                    env.configured()
                            ? new GeminiProvider(env.gemini(), restClientBuilder, json, null)
                            : new NoOpAIProvider();
                default -> new NoOpAIProvider();
            };
        }

        @Override
        public boolean enabled() {
            return delegate().enabled();
        }

        @Override
        public String name() {
            return delegate().name();
        }

        @Override
        public ChatResponse chat(ChatRequest request) {
            return delegate().chat(request);
        }

        @Override
        public void stream(ChatRequest request, TokenConsumer consumer) {
            delegate().stream(request, consumer);
        }

        @Override
        public float[] embed(String text) {
            return delegate().embed(text);
        }
    }
}
