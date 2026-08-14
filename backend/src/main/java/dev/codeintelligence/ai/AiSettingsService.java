package dev.codeintelligence.ai;

import dev.codeintelligence.auth.TokenCryptoService;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.StringUtils;

/** Per-user AI provider key, encrypted at rest. Used as a runtime override of the env config. */
@Service
public class AiSettingsService {

    private static final int MAX_API_KEY_LENGTH = 4096;

    public record SettingView(String provider, String model, String keyMasked, boolean keySet) {}

    public record ModelView(
            String id,
            boolean supportsStreaming,
            boolean supportsTools,
            boolean supportsReasoning,
            boolean supportsVision,
            int maxContextTokens) {}

    private final UserAiSettingRepository repository;
    private final TokenCryptoService crypto;
    private final AiProperties properties;
    private final AIProviderFactory providerFactory;
    private final TransactionTemplate transactions;

    public AiSettingsService(
            UserAiSettingRepository repository,
            TokenCryptoService crypto,
            AiProperties properties,
            AIProviderFactory providerFactory,
            PlatformTransactionManager transactionManager) {
        this.repository = repository;
        this.crypto = crypto;
        this.properties = properties;
        this.providerFactory = providerFactory;
        this.transactions = new TransactionTemplate(transactionManager);
    }

    @Transactional(readOnly = true)
    public Optional<SettingView> get(long userId) {
        return repository
                .findByUserId(userId)
                .map(setting -> new SettingView(
                        setting.getProvider(),
                        effectiveModel(setting),
                        mask(crypto.decrypt(setting.getKeyVersion(), setting.getNonce(), setting.getEncryptedKey())),
                        true));
    }

    /** Returns the decrypted key (server-side only; never serialized to responses). */
    @Transactional(readOnly = true)
    public Optional<StoredKey> getKey(long userId) {
        return repository
                .findByUserId(userId)
                .map(setting -> new StoredKey(
                        setting.getProvider(),
                        effectiveModel(setting),
                        crypto.decrypt(setting.getKeyVersion(), setting.getNonce(), setting.getEncryptedKey())));
    }

    public SettingView set(long userId, String provider, String model, String apiKey) {
        String normalizedProvider = provider == null ? "" : provider.strip().toLowerCase(Locale.ROOT);
        if (!"openai".equals(normalizedProvider) && !"gemini".equals(normalizedProvider)) {
            throw new InvalidAiSettingsException("Choose a supported AI provider.");
        }
        String normalizedModel = model == null ? "" : model.strip();
        if (!properties.supportsModel(normalizedProvider, normalizedModel)) {
            throw new InvalidAiSettingsException("Choose a supported model for this provider.");
        }
        String key = apiKey == null ? "" : apiKey.strip();
        if (key.length() > MAX_API_KEY_LENGTH) {
            throw new InvalidAiSettingsException("API key exceeds the 4096 character limit.");
        }
        Optional<UserAiSetting> existing = repository.findByUserId(userId);
        if (!StringUtils.hasText(key)) {
            key = existing.filter(setting -> normalizedProvider.equals(setting.getProvider()))
                    .map(setting ->
                            crypto.decrypt(setting.getKeyVersion(), setting.getNonce(), setting.getEncryptedKey()))
                    .orElse("");
        }
        if (!StringUtils.hasText(key)) {
            throw new InvalidAiSettingsException("Enter an API key before saving this provider.");
        }
        providerFactory.create(normalizedProvider, key, normalizedModel).testConnection();
        var encrypted = crypto.encrypt(key);
        String keyToMask = key;
        return transactions.execute(status -> {
            Optional<UserAiSetting> current = repository.findByUserId(userId);
            UserAiSetting setting =
                    current.orElseGet(() -> new UserAiSetting(userId, normalizedProvider, normalizedModel, encrypted));
            if (current.isPresent()) {
                setting.update(normalizedProvider, normalizedModel, encrypted);
            }
            repository.save(setting);
            return new SettingView(normalizedProvider, normalizedModel, mask(keyToMask), true);
        });
    }

    @Transactional(readOnly = true)
    public List<ModelView> models(String provider) {
        return properties.models(provider).stream()
                .map(model -> new ModelView(model, false, false, false, false, properties.maxContextTokens()))
                .toList();
    }

    @Transactional
    public void clear(long userId) {
        repository.findByUserId(userId).ifPresent(repository::delete);
    }

    private static String mask(String key) {
        if (key == null || key.length() <= 8) {
            return "••••";
        }
        return key.substring(0, 4) + "…" + key.substring(key.length() - 4);
    }

    private String effectiveModel(UserAiSetting setting) {
        if (StringUtils.hasText(setting.getModel())) {
            return setting.getModel();
        }
        return properties.models(setting.getProvider()).stream().findFirst().orElse("");
    }

    public record StoredKey(String provider, String model, String apiKey) {}
}
