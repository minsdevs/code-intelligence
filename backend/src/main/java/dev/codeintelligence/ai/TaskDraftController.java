package dev.codeintelligence.ai;

import dev.codeintelligence.common.security.AuthenticatedUser;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class TaskDraftController {

    private final LearningRecommendationService learningRecommendationService;

    public TaskDraftController(LearningRecommendationService learningRecommendationService) {
        this.learningRecommendationService = learningRecommendationService;
    }

    @PostMapping("/api/projects/{projectId}/findings/{findingId}/task-draft")
    @ResponseStatus(HttpStatus.CREATED)
    public TaskGenerationService.GeneratedTask fromFinding(
            @PathVariable long projectId,
            @PathVariable long findingId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return learningRecommendationService.fromFinding(projectId, user.userId(), findingId);
    }
}
