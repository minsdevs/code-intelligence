package dev.codeintelligence.ai;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.json.JsonMapper;

@Configuration
public class AIProviderConfig {

    @Bean
    AIProvider aiProvider(AiProperties properties, RestClient.Builder restClientBuilder, JsonMapper json) {
        return switch (properties.resolvedProvider()) {
            case "openai" -> {
                if (!properties.configured()) {
                    yield new NoOpAIProvider();
                }
                yield new OpenAIProvider(properties.openai(), restClientBuilder, json);
            }
            case "gemini" -> {
                if (!properties.configured()) {
                    yield new NoOpAIProvider();
                }
                yield new GeminiProvider(properties.gemini(), restClientBuilder, json);
            }
            default -> new NoOpAIProvider();
        };
    }
}
