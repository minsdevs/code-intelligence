package dev.codeintelligence.ai;

import org.springframework.stereotype.Service;

@Service
public class CodeExplanationService {
    public String systemPrompt() {
        return PromptBuilder.system(AiIntent.EXPLAIN);
    }
}
