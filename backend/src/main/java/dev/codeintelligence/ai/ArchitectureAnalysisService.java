package dev.codeintelligence.ai;

import org.springframework.stereotype.Service;

@Service
public class ArchitectureAnalysisService {
    public String systemPrompt() {
        return PromptBuilder.system(AiIntent.ARCHITECTURE);
    }
}
