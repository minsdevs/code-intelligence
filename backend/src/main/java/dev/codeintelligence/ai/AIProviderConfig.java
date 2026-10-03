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
            AiProperties properties, RestClient.Builder restClientBuilder, JsonMapper json, AiMainGatewayClient main) {
        return (provider, apiKey, model) -> main.enabled()
                ? new DesktopMetadataProvider(provider, model)
                : switch (provider == null ? "" : provider.strip().toLowerCase(Locale.ROOT)) {
                    case "openai" -> new OpenAIProvider(properties.openai(), restClientBuilder, json, apiKey, model);
                    case "gemini" -> new GeminiProvider(properties.gemini(), restClientBuilder, json, apiKey, model);
                    default -> new NoOpAIProvider();
                };
    }

    /** Helpers cannot send implicitly. Only an approved request plan reaches main's transport. */
    private record DesktopMetadataProvider(String name, String model) implements AIProvider {
        public boolean enabled() {
            return "openai".equals(name) && AiDesktopGateway.MODEL.equals(model);
        }

        public String embeddingModel() {
            return "";
        }

        public void testConnection() {
            throw new AiRequestPlanRequiredException();
        }

        public ChatResponse chat(ChatRequest request) {
            throw new AiRequestPlanRequiredException();
        }

        public void stream(ChatRequest request, TokenConsumer consumer) {
            throw new AiRequestPlanRequiredException();
        }

        public float[] embed(String text) {
            throw new AiRequestPlanRequiredException();
        }
    }

    @Bean
    AIProviderResolver aiProviderResolver(AiSettingsService settings, AIProviderFactory factory) {
        return new RuntimeAIProvider(settings, factory);
    }

    /**
     * A missing, OFF or reconnect-required preference cannot authorize any provider. Environment
     * credentials do not opt a user in. Every operation also revalidates the resolved revision.
     */
    static final class RuntimeAIProvider implements AIProviderResolver {

        private final AiSettingsService settings;
        private final AIProviderFactory factory;

        RuntimeAIProvider(AiSettingsService settings, AIProviderFactory factory) {
            this.settings = settings;
            this.factory = factory;
        }

        @Override
        public AIProvider resolve(long userId) {
            if (blockedReason() != null) return new NoOpAIProvider();
            var stored = settings.getKey(userId);
            if (stored.isPresent()) {
                AiSettingsService.StoredKey key = stored.get();
                AIProvider provider = factory.create(key.provider(), key.apiKey(), key.model());
                if (provider.enabled()) {
                    return new GuardedProvider(userId, key.revision(), provider, settings);
                }
            }
            return new NoOpAIProvider();
        }

        @Override
        public String blockedReason() {
            return settings.blockedReason();
        }
    }

    private record GuardedProvider(long userId, long revision, AIProvider delegate, AiSettingsService settings)
            implements AIProvider {
        @Override
        public boolean enabled() {
            return delegate.enabled();
        }

        @Override
        public String name() {
            return delegate.name();
        }

        @Override
        public String model() {
            return delegate.model();
        }

        @Override
        public String embeddingModel() {
            return delegate.embeddingModel();
        }

        @Override
        public void testConnection() {
            settings.call(userId, revision, () -> {
                delegate.testConnection();
                return null;
            });
        }

        @Override
        public ChatResponse chat(ChatRequest request) {
            return settings.call(userId, revision, () -> delegate.chat(request));
        }

        @Override
        public void stream(ChatRequest request, TokenConsumer consumer) {
            settings.call(userId, revision, () -> {
                delegate.stream(request, consumer);
                return null;
            });
        }

        @Override
        public float[] embed(String text) {
            return settings.call(userId, revision, () -> delegate.embed(text));
        }
    }
}
