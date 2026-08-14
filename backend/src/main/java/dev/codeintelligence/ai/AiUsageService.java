package dev.codeintelligence.ai;

import java.util.Locale;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

@Service
public class AiUsageService {

    private final JdbcClient jdbc;
    private final AiProperties aiProperties;

    public AiUsageService(JdbcClient jdbc, AiProperties aiProperties) {
        this.jdbc = jdbc;
        this.aiProperties = aiProperties;
    }

    public void enforceBudget(long userId) {
        Long used = jdbc.sql("""
                        select coalesce(sum(prompt_tokens + completion_tokens), 0)
                        from ai_usage_logs
                        where user_id = :userId and created_at >= date_trunc('day', now())
                        """).param("userId", userId).query(Long.class).single();
        if (used != null && used >= aiProperties.dailyTokenLimit()) {
            throw new AiBudgetExceededException();
        }
    }

    public void log(
            long userId, long projectId, AIProvider provider, String purpose, AIProvider.ChatResponse response) {
        jdbc.sql("""
                        insert into ai_usage_logs (user_id, project_id, provider, model, purpose, prompt_tokens, completion_tokens)
                        values (:userId, :projectId, :provider, :model, :purpose, :prompt, :completion)
                        """)
                .param("userId", userId)
                .param("projectId", projectId)
                .param("provider", provider.name())
                .param("model", provider.model())
                .param("purpose", purpose.toLowerCase(Locale.ROOT))
                .param("prompt", response.promptTokens())
                .param("completion", response.completionTokens())
                .update();
    }
}
