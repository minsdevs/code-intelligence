package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.Optional;
import org.junit.jupiter.api.Test;

class RuntimeAIProviderTest {

    @Test
    void resolvesOnlyTheRequestingUsersStoredKey() {
        AiSettingsService settings = mock(AiSettingsService.class);
        when(settings.getKey(17L)).thenReturn(Optional.empty());
        AiProperties properties = new AiProperties(
                "",
                8000,
                500000,
                40,
                new AiProperties.OpenAi("", "https://api.openai.com", "gpt-4o-mini", "text-embedding-3-small"),
                new AiProperties.Gemini(
                        "", "https://generativelanguage.googleapis.com", "gemini-2.5-flash", "gemini-embedding-001"));
        AIProviderConfig.RuntimeAIProvider provider = new AIProviderConfig.RuntimeAIProvider(
                properties, settings, (name, key, model) -> new NoOpAIProvider());

        boolean enabled = provider.resolve(17L).enabled();

        assertThat(enabled).isFalse();
        verify(settings).getKey(17L);
    }
}
