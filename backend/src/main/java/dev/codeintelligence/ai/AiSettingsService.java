package dev.codeintelligence.ai;

import dev.codeintelligence.auth.TokenCryptoService;
import java.util.Optional;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

/** Per-user AI provider key, encrypted at rest. Used as a runtime override of the env config. */
@Service
public class AiSettingsService {

    public record SettingView(String provider, String keyMasked, boolean keySet) {}

    private final UserAiSettingRepository repository;
    private final TokenCryptoService crypto;

    public AiSettingsService(UserAiSettingRepository repository, TokenCryptoService crypto) {
        this.repository = repository;
        this.crypto = crypto;
    }

    @Transactional(readOnly = true)
    public Optional<SettingView> get(long userId) {
        return repository
                .findByUserId(userId)
                .map(setting -> new SettingView(
                        setting.getProvider(),
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
                        crypto.decrypt(setting.getKeyVersion(), setting.getNonce(), setting.getEncryptedKey())));
    }

    /**
     * Global (any-user) key override for the provider factory. The app is a local single-user
     * tool, so the most recently saved key wins and is picked up without a restart.
     */
    @Transactional(readOnly = true)
    public Optional<StoredKey> latestKey() {
        Iterable<UserAiSetting> all = repository.findAll();
        UserAiSetting newest = null;
        for (UserAiSetting setting : all) {
            if (newest == null || setting.getUpdatedAt().isAfter(newest.getUpdatedAt())) {
                newest = setting;
            }
        }
        if (newest == null) {
            return Optional.empty();
        }
        return Optional.of(new StoredKey(
                newest.getProvider(),
                crypto.decrypt(newest.getKeyVersion(), newest.getNonce(), newest.getEncryptedKey())));
    }

    @Transactional
    public SettingView set(long userId, String provider, String apiKey) {
        String normalizedProvider = provider == null ? "" : provider.strip().toLowerCase();
        if (!"openai".equals(normalizedProvider) && !"gemini".equals(normalizedProvider)) {
            throw new InvalidAiQuestionException();
        }
        String key = apiKey == null ? "" : apiKey.strip();
        if (!StringUtils.hasText(key)) {
            throw new InvalidAiQuestionException();
        }
        var encrypted = crypto.encrypt(key);
        repository
                .findByUserId(userId)
                .ifPresentOrElse(
                        setting -> setting.update(normalizedProvider, encrypted),
                        () -> repository.save(new UserAiSetting(userId, normalizedProvider, encrypted)));
        return new SettingView(normalizedProvider, mask(key), true);
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

    public record StoredKey(String provider, String apiKey) {}
}
