package dev.codeintelligence.ai;

import dev.codeintelligence.common.security.AuthenticatedUser;
import java.util.List;
import java.util.Optional;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AiSettingsController {

    public record SaveBody(String provider, String model, String apiKey) {}

    private final AiSettingsService settings;

    public AiSettingsController(AiSettingsService settings) {
        this.settings = settings;
    }

    @GetMapping("/api/ai/settings")
    public Optional<AiSettingsService.SettingView> get(@AuthenticationPrincipal AuthenticatedUser user) {
        return settings.get(user.userId());
    }

    @PutMapping("/api/ai/settings")
    public AiSettingsService.SettingView save(
            @RequestBody SaveBody body, @AuthenticationPrincipal AuthenticatedUser user) {
        if (body == null) {
            throw new InvalidAiQuestionException();
        }
        return settings.set(user.userId(), body.provider(), body.model(), body.apiKey());
    }

    @GetMapping("/api/ai/settings/models")
    public List<AiSettingsService.ModelView> models(
            @org.springframework.web.bind.annotation.RequestParam String provider) {
        return settings.models(provider);
    }

    @DeleteMapping("/api/ai/settings")
    public AiSettingsService.SettingView clear(@AuthenticationPrincipal AuthenticatedUser user) {
        return settings.clear(user.userId());
    }
}
