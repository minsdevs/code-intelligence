package dev.codeintelligence.ai;

import org.springframework.stereotype.Service;

@Service
public class LearningRecommendationService {

    private final TaskGenerationService taskGenerationService;

    public LearningRecommendationService(TaskGenerationService taskGenerationService) {
        this.taskGenerationService = taskGenerationService;
    }

    public TaskGenerationService.GeneratedTask fromFinding(long projectId, long userId, long findingId) {
        return taskGenerationService.fromFinding(projectId, userId, findingId);
    }
}
