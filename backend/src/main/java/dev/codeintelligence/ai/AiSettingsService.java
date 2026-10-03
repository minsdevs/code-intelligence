package dev.codeintelligence.ai;

import dev.codeintelligence.auth.TokenCryptoService;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.function.Supplier;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.StringUtils;

/** Explicit per-user connections. OFF/reconnect preferences never fall back to an environment key. */
@Service
public class AiSettingsService {

    private static final int MAX_API_KEY_LENGTH = 4096;

    public record SettingView(
            String provider, String model, String keyMasked, boolean keySet, String state, int activeRequests) {}

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
    private final AiPreferenceStore preferences;
    private final AiDispatchGate gate;
    private final AiDesktopGateway desktop;

    public AiSettingsService(
            UserAiSettingRepository repository,
            TokenCryptoService crypto,
            AiProperties properties,
            AIProviderFactory providerFactory,
            PlatformTransactionManager transactionManager,
            AiPreferenceStore preferences,
            AiDispatchGate gate) {
        this(repository, crypto, properties, providerFactory, transactionManager, preferences, gate, null);
    }

    @Autowired
    public AiSettingsService(
            UserAiSettingRepository repository,
            TokenCryptoService crypto,
            AiProperties properties,
            AIProviderFactory providerFactory,
            PlatformTransactionManager transactionManager,
            AiPreferenceStore preferences,
            AiDispatchGate gate,
            AiDesktopGateway desktop) {
        this.repository = repository;
        this.crypto = crypto;
        this.properties = properties;
        this.providerFactory = providerFactory;
        this.transactions = new TransactionTemplate(transactionManager);
        // A control operation must commit before the admission monitor is released, even if the
        // caller happens to have an ambient transaction. No provider runs inside this transaction.
        this.transactions.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        this.preferences = preferences;
        this.gate = gate;
        this.desktop = desktop;
    }

    @Transactional(readOnly = true)
    public Optional<SettingView> get(long userId) {
        return preferences.find(userId).map(preference -> {
            Optional<StoredKey> key = "ENABLED".equals(preference.state())
                    ? getKey(userId).filter(value -> value.revision() == preference.revision())
                    : Optional.empty();
            String state =
                    "ENABLED".equals(preference.state()) && key.isEmpty() ? "RECONNECT_REQUIRED" : preference.state();
            return new SettingView(
                    preference.provider(),
                    effectiveModel(preference.provider(), preference.model()),
                    key.map(value -> mask(value.apiKey())).orElse(null),
                    key.isPresent(),
                    state,
                    activeRequests(userId));
        });
    }

    /** Returns the decrypted key (server-side only; never serialized to responses). */
    @Transactional(readOnly = true)
    public Optional<StoredKey> getKey(long userId) {
        return preferences.activeCredential(userId).flatMap(setting -> {
            String key;
            try {
                key = crypto.decrypt(setting.keyVersion(), setting.nonce(), setting.encryptedKey());
            } catch (IllegalStateException unreadableCredential) {
                // A lost wrapping key, unknown key version or damaged ciphertext needs reconnect.
                // Only decryption is covered: database failures must still surface as failures.
                return Optional.empty();
            }
            String model = effectiveModel(setting.provider(), setting.model());
            if (!StringUtils.hasText(key)
                    || key.length() > MAX_API_KEY_LENGTH
                    || !supportsModel(setting.provider(), model)) return Optional.empty();
            return Optional.of(new StoredKey(setting.provider(), model, key, setting.revision()));
        });
    }

    public SettingView set(long userId, String provider, String model, String apiKey) {
        gate.requireSafety();
        String normalizedProvider = provider == null ? "" : provider.strip().toLowerCase(Locale.ROOT);
        if (!"openai".equals(normalizedProvider) && !"gemini".equals(normalizedProvider)) {
            throw new InvalidAiSettingsException("Choose a supported AI provider.");
        }
        String normalizedModel = model == null ? "" : model.strip();
        if (!supportsModel(normalizedProvider, normalizedModel)) {
            throw new InvalidAiSettingsException("Choose a supported model for this provider.");
        }
        String key = apiKey == null ? "" : apiKey.strip();
        if (key.length() > MAX_API_KEY_LENGTH) {
            throw new InvalidAiSettingsException("API key exceeds the 4096 character limit.");
        }
        String suppliedKey = key;
        if (isDesktop()) desktop.latch();
        PendingConnection pending = gate.control(() -> transactions.execute(status -> {
            String selectedKey = suppliedKey;
            if (!StringUtils.hasText(selectedKey)) {
                selectedKey = getKey(userId)
                        .filter(value -> normalizedProvider.equals(value.provider()))
                        .map(StoredKey::apiKey)
                        .orElse("");
            }
            if (!StringUtils.hasText(selectedKey)) {
                throw new InvalidAiSettingsException("Enter an API key before saving this provider.");
            }
            return new PendingConnection(preferences.beginSave(userId), selectedKey);
        }));
        // Desktop Save stores the key while main remains OFF. Its first provider request requires
        // separate budget activation and request approval; Save never performs a network probe.
        if (!isDesktop())
            gate.call(userId, () -> preferences.revisionMatches(userId, pending.revision(), false), () -> {
                providerFactory
                        .create(normalizedProvider, pending.apiKey(), normalizedModel)
                        .testConnection();
                return null;
            });
        var encrypted = crypto.encrypt(pending.apiKey());
        return gate.control(() -> transactions.execute(status -> {
            if (!preferences.enable(userId, pending.revision(), normalizedProvider, normalizedModel)) {
                throw new AiSettingsChangedException();
            }
            Optional<UserAiSetting> current = repository.findByUserId(userId);
            UserAiSetting setting =
                    current.orElseGet(() -> new UserAiSetting(userId, normalizedProvider, normalizedModel, encrypted));
            if (current.isPresent()) setting.update(normalizedProvider, normalizedModel, encrypted);
            repository.save(setting);
            return new SettingView(
                    normalizedProvider,
                    normalizedModel,
                    mask(pending.apiKey()),
                    true,
                    "ENABLED",
                    activeRequests(userId));
        }));
    }

    @Transactional(readOnly = true)
    public List<ModelView> models(String provider) {
        if (isDesktop())
            return "openai".equals(provider)
                    ? List.of(new ModelView(AiDesktopGateway.MODEL, false, false, false, false, 128000))
                    : List.of();
        return properties.models(provider).stream()
                .map(model -> new ModelView(model, false, false, false, false, properties.maxContextTokens()))
                .toList();
    }

    public SettingView clear(long userId) {
        RuntimeException latchFailure = null;
        try {
            if (isDesktop()) desktop.latch();
        } catch (RuntimeException failure) {
            latchFailure = failure;
        }
        SettingView result = gate.control(() -> {
            transactions.executeWithoutResult(status -> {
                preferences.disable(userId);
                repository.findByUserId(userId).ifPresent(repository::delete);
            });
            return get(userId).orElseThrow();
        });
        if (latchFailure != null) throw new AiSafetyUnavailableException();
        return result;
    }

    <T> T call(long userId, long revision, Supplier<T> action) {
        return gate.call(
                userId,
                () -> getKey(userId).filter(key -> key.revision() == revision).isPresent(),
                action);
    }

    String blockedReason() {
        return gate.blockedReason();
    }

    private static String mask(String key) {
        if (key == null || key.length() <= 8) {
            return "••••";
        }
        return key.substring(0, 4) + "…" + key.substring(key.length() - 4);
    }

    private String effectiveModel(String provider, String model) {
        if (StringUtils.hasText(model)) {
            return model;
        }
        if (provider == null) return null;
        if (isDesktop()) return "openai".equals(provider) ? AiDesktopGateway.MODEL : "";
        return properties.models(provider).stream().findFirst().orElse("");
    }

    private boolean isDesktop() {
        return desktop != null && desktop.enabled();
    }

    private int activeRequests(long userId) {
        return isDesktop() ? desktop.activeRequests() : gate.activeRequests(userId);
    }

    private boolean supportsModel(String provider, String model) {
        return isDesktop()
                ? "openai".equals(provider) && AiDesktopGateway.MODEL.equals(model)
                : properties.supportsModel(provider, model);
    }

    private record PendingConnection(long revision, String apiKey) {
        @Override
        public String toString() {
            return "PendingConnection[redacted]";
        }
    }

    public record StoredKey(String provider, String model, String apiKey, long revision) {
        @Override
        public String toString() {
            return "StoredKey[redacted]";
        }
    }
}
