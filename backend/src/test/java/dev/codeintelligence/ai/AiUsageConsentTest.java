package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;

class AiUsageConsentTest {
    @Test
    void unplannedChatIsRejectedBeforeProviderOrDatabaseAccess() {
        JdbcClient jdbc = mock(JdbcClient.class);
        AIProvider provider = mock(AIProvider.class);
        AiUsageService usage = new AiUsageService(jdbc, mock(AiProperties.class));
        assertThatThrownBy(() -> usage.chat(
                        1, 2, provider, "review", new AIProvider.ChatRequest("system", "private source", true)))
                .isInstanceOf(AiRequestPlanRequiredException.class);
        assertThatThrownBy(usage::requireRequestPlan).isInstanceOf(AiRequestPlanRequiredException.class);
        verifyNoInteractions(provider, jdbc);
    }
}
