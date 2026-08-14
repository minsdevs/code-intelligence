package dev.codeintelligence.ai;

import org.springframework.stereotype.Service;

@Service
public class ProjectAreaAnalysisService {
    public String systemPrompt() {
        return PromptBuilder.system(AiIntent.PROJECT);
    }
}
