package dev.codeintelligence.ai;

import org.springframework.stereotype.Service;

@Service
public class AlternativeAnalysisService {
    public String systemPrompt() {
        return PromptBuilder.system(AiIntent.ALTERNATIVE);
    }
}
