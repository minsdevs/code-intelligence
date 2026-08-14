package dev.codeintelligence.ai;

import org.springframework.stereotype.Service;

@Service
public class WhyAnalysisService {
    public String systemPrompt() {
        return PromptBuilder.system(AiIntent.WHY);
    }
}
