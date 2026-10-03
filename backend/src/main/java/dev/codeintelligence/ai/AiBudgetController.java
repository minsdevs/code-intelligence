package dev.codeintelligence.ai;

import dev.codeintelligence.common.security.AuthenticatedUser;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
public final class AiBudgetController {
    public record Limits(String expectedRevision, String dailyLimitMicroUsd, String monthlyLimitMicroUsd) {}

    public record Activation(String expectedRevision, String activationToken) {
        @Override
        public String toString() {
            return "AiBudgetActivation[redacted]";
        }
    }

    private final AiDesktopGateway gateway;

    public AiBudgetController(AiDesktopGateway gateway) {
        this.gateway = gateway;
    }

    @GetMapping("/api/ai/budget")
    public AiDesktopGateway.Budget get(@AuthenticationPrincipal AuthenticatedUser user) {
        return gateway.budget(user.userId());
    }

    @PutMapping("/api/ai/budget")
    public AiDesktopGateway.Budget configure(
            @AuthenticationPrincipal AuthenticatedUser user, @RequestBody Limits body) {
        if (body == null) throw new InvalidAiSettingsException("Specify daily and monthly limits.");
        return gateway.configure(
                user.userId(), body.expectedRevision(), body.dailyLimitMicroUsd(), body.monthlyLimitMicroUsd());
    }

    @PostMapping("/api/ai/budget/activate")
    public AiDesktopGateway.Budget activate(
            @AuthenticationPrincipal AuthenticatedUser user, @RequestBody Activation body) {
        if (body == null) throw new InvalidAiSettingsException("Review the current budget before enabling AI.");
        return gateway.activate(user.userId(), body.expectedRevision(), body.activationToken());
    }
}
