package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.mock.env.MockEnvironment;

class AiSafetyPolicyTest {
    @Test
    void aDesktopProfileAloneCannotBypassTheReleaseGuard() {
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles("desktop");
        assertBlocked(new AiSafetyPolicy(environment));
    }

    @ParameterizedTest
    @ValueSource(strings = {"api-token", "local-identity", "allowed-origin"})
    void partialDesktopAuthenticationConfigurationIsAlsoBlocked(String property) {
        assertBlocked(new AiSafetyPolicy(new MockEnvironment().withProperty("app.desktop." + property, "synthetic")));
    }

    @Test
    void browserDevelopmentStillRequiresTheSeparatePerUserAdmissionPredicate() {
        AiSafetyPolicy policy = new AiSafetyPolicy(new MockEnvironment());
        assertThat(policy.blockedReason()).isNull();
        AtomicBoolean sent = new AtomicBoolean();
        assertThatThrownBy(() -> new AiDispatchGate(policy).call(1, () -> false, () -> sent.getAndSet(true)))
                .isInstanceOf(AiSettingsChangedException.class);
        assertThat(sent).isFalse();
    }

    private static void assertBlocked(AiSafetyPolicy policy) {
        assertThat(policy.blockedReason()).isEqualTo("DESKTOP_AI_SAFETY_UNAVAILABLE");
        AtomicBoolean checkedCredential = new AtomicBoolean();
        AtomicBoolean sent = new AtomicBoolean();
        AiDispatchGate gate = new AiDispatchGate(policy);
        assertThatThrownBy(() -> gate.call(
                        1,
                        () -> {
                            checkedCredential.set(true);
                            return true;
                        },
                        () -> sent.getAndSet(true)))
                .isInstanceOf(AiSafetyUnavailableException.class);
        assertThat(checkedCredential).isFalse();
        assertThat(sent).isFalse();
        assertThat(gate.activeRequests(1)).isZero();
    }
}
