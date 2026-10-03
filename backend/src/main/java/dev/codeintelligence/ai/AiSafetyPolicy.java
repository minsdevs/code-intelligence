package dev.codeintelligence.ai;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

/**
 * A desktop backend must have the inherited private main channel. This is an availability check,
 * not dispatch authority: main separately requires approval, budget, journal and current settings.
 */
@Component
public class AiSafetyPolicy {
    private final Environment environment;
    private final AiMainGatewayClient main;

    public AiSafetyPolicy(Environment environment) {
        this(environment, null);
    }

    @Autowired
    public AiSafetyPolicy(Environment environment, AiMainGatewayClient main) {
        this.environment = environment;
        this.main = main;
    }

    public String blockedReason() {
        boolean desktop = environment.acceptsProfiles(Profiles.of("desktop"))
                || StringUtils.hasText(environment.getProperty("app.desktop.api-token"))
                || StringUtils.hasText(environment.getProperty("app.desktop.local-identity"))
                || StringUtils.hasText(environment.getProperty("app.desktop.allowed-origin"));
        return desktop && (main == null || !main.enabled()) ? "DESKTOP_AI_SAFETY_UNAVAILABLE" : null;
    }

    void requireAvailable() {
        if (blockedReason() != null) throw new AiSafetyUnavailableException();
    }
}
