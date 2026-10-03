package dev.codeintelligence.ai;

import dev.codeintelligence.common.security.AuthenticatedUser;
import java.util.List;
import java.util.Set;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * POST /api/projects/{projectId}/ai/preview — returns a preview of what would be sent to the AI
 * provider without making any external request. Uses bounded local context and existing cached
 * summaries; it does not generate summaries or embeddings to fill missing context.
 */
@RestController
public class AiPreviewController {

    private final AiPreviewService previewService;

    public AiPreviewController(AiPreviewService previewService) {
        this.previewService = previewService;
    }

    @PostMapping("/api/projects/{projectId}/ai/preview")
    public AiPreviewService.AiPreviewResponse preview(
            @PathVariable long projectId,
            @RequestBody AssistantController.AskBody body,
            @AuthenticationPrincipal AuthenticatedUser user) {
        AssistantController.AskBody safe = body == null
                ? new AssistantController.AskBody(
                        null, null, null, null, null, null, null, null, null, null, List.of(), List.of())
                : body;
        ContextRetrievalService.AskContext context = new ContextRetrievalService.AskContext(
                safe.view(),
                safe.focusedFile(),
                safe.focusedNodeId(),
                safe.focusedCommitSha(),
                safe.focusedFindingId(),
                safe.focusedNoteId(),
                safe.focusedTaskId(),
                safe.selectedAreas() == null ? List.of() : safe.selectedAreas());
        String question = safe.question() == null ? "" : safe.question();
        return previewService.preview(
                projectId,
                user.userId(),
                question,
                context,
                safe.excludedContextIds() == null ? Set.of() : Set.copyOf(safe.excludedContextIds()));
    }
}
