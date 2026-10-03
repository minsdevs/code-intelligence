package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import dev.codeintelligence.auth.TokenCryptoProperties;
import dev.codeintelligence.auth.TokenCryptoService;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.SimpleTransactionStatus;

class AiSettingsServiceTest {

    private static final String KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

    @Test
    void validatesConnectionBeforePersistingNewKey() {
        UserAiSettingRepository repository = mock(UserAiSettingRepository.class);
        AIProvider provider = mock(AIProvider.class);
        AIProviderFactory factory = mock(AIProviderFactory.class);
        when(factory.create("openai", "sk-test-key", "gpt-4o-mini")).thenReturn(provider);
        PlatformTransactionManager transactionManager = transactionManager();
        AiSettingsService service = service(repository, factory, transactionManager);

        AiSettingsService.SettingView result = service.set(7L, "openai", "gpt-4o-mini", "sk-test-key");

        assertThat(result.provider()).isEqualTo("openai");
        assertThat(result.model()).isEqualTo("gpt-4o-mini");
        assertThat(result.keyMasked()).doesNotContain("test-key");
        verify(provider).testConnection();
        verify(repository).save(any(UserAiSetting.class));
        InOrder order = inOrder(provider, transactionManager);
        order.verify(provider).testConnection();
        order.verify(transactionManager).getTransaction(any(TransactionDefinition.class));
    }

    @Test
    void rejectsUnsupportedModelWithoutCallingProvider() {
        UserAiSettingRepository repository = mock(UserAiSettingRepository.class);
        AIProviderFactory factory = mock(AIProviderFactory.class);
        AiSettingsService service = service(repository, factory);

        assertThatThrownBy(() -> service.set(7L, "openai", "not-a-model", "sk-test-key"))
                .isInstanceOf(InvalidAiSettingsException.class)
                .hasMessageContaining("supported model");
        verifyNoInteractions(factory);
    }

    @Test
    void rejectsOversizedKeyWithoutCallingProvider() {
        UserAiSettingRepository repository = mock(UserAiSettingRepository.class);
        AIProviderFactory factory = mock(AIProviderFactory.class);
        AiSettingsService service = service(repository, factory);

        assertThatThrownBy(() -> service.set(7L, "openai", "gpt-4o-mini", "x".repeat(4097)))
                .isInstanceOf(InvalidAiSettingsException.class)
                .hasMessageContaining("4096");
        verifyNoInteractions(repository, factory);
    }

    @Test
    void retainsExistingKeyWhenChangingOnlyTheModel() {
        UserAiSettingRepository repository = mock(UserAiSettingRepository.class);
        TokenCryptoService crypto = new TokenCryptoService(new TokenCryptoProperties(KEY));
        UserAiSetting existing = new UserAiSetting(7L, "openai", "gpt-4o-mini", crypto.encrypt("sk-existing-key"));
        when(repository.findByUserId(7L)).thenReturn(Optional.of(existing));
        AIProvider provider = mock(AIProvider.class);
        AIProviderFactory factory = mock(AIProviderFactory.class);
        when(factory.create(eq("openai"), eq("sk-existing-key"), eq("gpt-4o-mini")))
                .thenReturn(provider);
        AiPreferenceStore preferences = preferences();
        var encrypted = crypto.encrypt("sk-existing-key");
        when(preferences.activeCredential(7L))
                .thenReturn(Optional.of(new AiPreferenceStore.ActiveCredential(
                        "openai",
                        "gpt-4o-mini",
                        1L,
                        encrypted.keyVersion(),
                        encrypted.nonce(),
                        encrypted.ciphertext())));
        AiSettingsService service = service(repository, crypto, factory, transactionManager(), preferences);

        AiSettingsService.SettingView result = service.set(7L, "openai", "gpt-4o-mini", "");

        assertThat(result.keyMasked()).doesNotContain("existing-key");
        verify(provider).testConnection();
        verify(repository).save(existing);
        assertThat(existing.getModel()).isEqualTo("gpt-4o-mini");
    }

    private static AiSettingsService service(UserAiSettingRepository repository, AIProviderFactory factory) {
        return service(repository, factory, transactionManager());
    }

    private static AiSettingsService service(
            UserAiSettingRepository repository,
            AIProviderFactory factory,
            PlatformTransactionManager transactionManager) {
        return service(repository, new TokenCryptoService(new TokenCryptoProperties(KEY)), factory, transactionManager);
    }

    private static AiSettingsService service(
            UserAiSettingRepository repository, TokenCryptoService crypto, AIProviderFactory factory) {
        return service(repository, crypto, factory, transactionManager());
    }

    private static AiSettingsService service(
            UserAiSettingRepository repository,
            TokenCryptoService crypto,
            AIProviderFactory factory,
            PlatformTransactionManager transactionManager) {
        return service(repository, crypto, factory, transactionManager, preferences());
    }

    private static AiSettingsService service(
            UserAiSettingRepository repository,
            TokenCryptoService crypto,
            AIProviderFactory factory,
            PlatformTransactionManager transactionManager,
            AiPreferenceStore preferences) {
        AiProperties properties = new AiProperties(
                "",
                8000,
                500000,
                40,
                new AiProperties.OpenAi("", "https://api.openai.com", "gpt-4o-mini", "text-embedding-3-small"),
                new AiProperties.Gemini(
                        "", "https://generativelanguage.googleapis.com", "gemini-2.5-flash", "gemini-embedding-001"));
        return new AiSettingsService(
                repository,
                crypto,
                properties,
                factory,
                transactionManager,
                preferences,
                new AiDispatchGate(new AiSafetyPolicy(new org.springframework.mock.env.MockEnvironment())));
    }

    private static AiPreferenceStore preferences() {
        AiPreferenceStore preferences = mock(AiPreferenceStore.class);
        when(preferences.beginSave(anyLong())).thenReturn(1L);
        when(preferences.revisionMatches(anyLong(), anyLong(), anyBoolean())).thenReturn(true);
        when(preferences.enable(anyLong(), anyLong(), anyString(), anyString())).thenReturn(true);
        return preferences;
    }

    private static PlatformTransactionManager transactionManager() {
        PlatformTransactionManager transactionManager = mock(PlatformTransactionManager.class);
        when(transactionManager.getTransaction(any(TransactionDefinition.class)))
                .thenReturn(new SimpleTransactionStatus());
        return transactionManager;
    }
}
