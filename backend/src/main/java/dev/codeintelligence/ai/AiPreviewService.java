package dev.codeintelligence.ai;

import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.project.SnapshotRepository;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

/**
 * Previews what would be sent to the AI provider without making any external request.
 * Reuses the same ContextRetrievalService.retrieveStructured() code path as the actual ask flow,
 * ensuring the preview faithfully represents what would be transmitted.
 */
@Service
public class AiPreviewService {

    private static final Pattern REDACTED_PATTERN = Pattern.compile("\\[REDACTED]");

    public record ContextItem(String id, String type, String label, int charCount, boolean masked) {}

    public record AiPreviewResponse(
            List<ContextItem> contextItems,
            List<String> fileRefs,
            int totalChars,
            int estimatedInputTokens,
            int estimatedOutputTokens,
            double estimatedCostUsd,
            String provider,
            String model,
            int maskedSecrets,
            boolean localOnly) {}

    private final ProjectRepository projectRepository;
    private final SnapshotRepository snapshotRepository;
    private final ContextRetrievalService retrieval;
    private final AIProviderResolver providerResolver;
    private final AiProperties aiProperties;

    public AiPreviewService(
            ProjectRepository projectRepository,
            SnapshotRepository snapshotRepository,
            ContextRetrievalService retrieval,
            AIProviderResolver providerResolver,
            AiProperties aiProperties) {
        this.projectRepository = projectRepository;
        this.snapshotRepository = snapshotRepository;
        this.retrieval = retrieval;
        this.providerResolver = providerResolver;
        this.aiProperties = aiProperties;
    }

    public AiPreviewResponse preview(
            long projectId, long userId, String question, ContextRetrievalService.AskContext context) {
        Project project =
                projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
        Long snapshotId = project.getCurrentSnapshotId();
        if (snapshotId == null) {
            throw new dev.codeintelligence.analysis.core.SnapshotNotFoundException();
        }
        snapshotRepository
                .findByIdAndProjectId(snapshotId, project.getId())
                .orElseThrow(dev.codeintelligence.analysis.core.SnapshotNotFoundException::new);

        // Use the structured retrieval path — same logic as the real ask flow
        ContextRetrievalService.StructuredRetrieved structured =
                retrieval.retrieveStructured(userId, projectId, snapshotId, project.getClonePath(), context, question);

        String text = structured.text();
        List<String> fileRefs = structured.fileRefs();

        // Build context items from structured blocks (with deterministic IDs)
        List<ContextItem> items = new ArrayList<>();
        for (ContextRetrievalService.ContextBlock block : structured.blocks()) {
            items.add(new ContextItem(
                    block.id(),
                    block.type(),
                    block.label().length() > 80 ? block.label().substring(0, 80) + "..." : block.label(),
                    block.content().length(),
                    block.content().contains("[REDACTED]")));
        }

        // Count masked secrets
        int maskedSecrets = countRedacted(text);

        // Determine provider and model
        AIProvider provider = providerResolver.resolve(userId);
        String providerName = provider.enabled() ? provider.name() : aiProperties.resolvedProvider();
        String modelName = provider.enabled() ? provider.model() : "";

        // Token and cost estimation
        int totalChars = text.length();
        int estimatedInputTokens = totalChars / 4;
        int estimatedOutputTokens = Math.min(4096, (int) (estimatedInputTokens * 0.3));
        double cost = estimateCost(providerName, estimatedInputTokens, estimatedOutputTokens);

        return new AiPreviewResponse(
                items,
                fileRefs,
                totalChars,
                estimatedInputTokens,
                estimatedOutputTokens,
                cost,
                providerName,
                modelName,
                maskedSecrets,
                true); // always local-only: no external request
    }

    int countRedacted(String text) {
        if (text == null) return 0;
        Matcher matcher = REDACTED_PATTERN.matcher(text);
        int count = 0;
        while (matcher.find()) {
            count++;
        }
        return count;
    }

    double estimateCost(String provider, int inputTokens, int outputTokens) {
        return switch (provider == null ? "" : provider.toLowerCase()) {
            case "gemini" -> inputTokens * 0.075 / 1_000_000.0 + outputTokens * 0.30 / 1_000_000.0;
            default -> // OpenAI pricing as default
                inputTokens * 0.15 / 1_000_000.0 + outputTokens * 0.60 / 1_000_000.0;
        };
    }
}
