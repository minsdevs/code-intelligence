package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;

class AiPropertiesBindingTest {
    @ParameterizedTest
    @ValueSource(strings = {"openai", "gemini"})
    void nestedProviderSettingsUseTheCanonicalConstructor(String provider) {
        var source = new MapConfigurationPropertySource(Map.of(
                "app.ai.provider",
                provider,
                "app.ai." + provider + ".api-key",
                "synthetic-binding-key",
                "app.ai." + provider + ".chat-model",
                "synthetic-default",
                "app.ai." + provider + ".chat-models",
                "synthetic-alternate",
                "app.ai." + provider + ".embed-model",
                "synthetic-embedding"));

        AiProperties bound = new Binder(source)
                .bind("app.ai", Bindable.of(AiProperties.class))
                .get();

        assertThat(bound.configured()).isTrue();
        assertThat(bound.models(provider)).containsExactly("synthetic-alternate", "synthetic-default");
        assertThat(
                        "openai".equals(provider)
                                ? bound.openai().embedModel()
                                : bound.gemini().embedModel())
                .isEqualTo("synthetic-embedding");
    }
}
