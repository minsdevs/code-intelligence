package dev.codeintelligence.ai;

import dev.codeintelligence.common.security.AuthenticatedUser;
import java.io.IOException;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.springframework.http.MediaType;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import tools.jackson.databind.json.JsonMapper;

@RestController
public class AssistantController {

    public record AskBody(
            Long conversationId,
            String question,
            String intent,
            String view,
            String focusedFile,
            Long focusedNodeId,
            String focusedCommitSha,
            Long focusedFindingId,
            Long focusedNoteId,
            Long focusedTaskId,
            List<String> selectedAreas) {}

    private final AssistantService assistantService;
    private final JsonMapper json;
    private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();

    public AssistantController(AssistantService assistantService, JsonMapper json) {
        this.assistantService = assistantService;
        this.json = json;
    }

    @GetMapping("/api/ai/status")
    public AssistantService.AiStatus status() {
        return assistantService.status();
    }

    @PostMapping("/api/projects/{projectId}/ai/ask")
    public AssistantService.AskResponse ask(
            @PathVariable long projectId, @RequestBody AskBody body, @AuthenticationPrincipal AuthenticatedUser user) {
        return assistantService.ask(projectId, user.userId(), toRequest(body));
    }

    @PostMapping(value = "/api/projects/{projectId}/ai/ask/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(
            @PathVariable long projectId, @RequestBody AskBody body, @AuthenticationPrincipal AuthenticatedUser user) {
        SseEmitter emitter = new SseEmitter(Duration.ofMinutes(2).toMillis());
        AssistantService.AskRequest request = toRequest(body);
        executor.execute(() -> {
            try {
                AssistantService.AskResponse response = assistantService.ask(projectId, user.userId(), request);
                OpenAIProvider.chunk(response.explanation(), token -> {
                    try {
                        emitter.send(SseEmitter.event().name("token").data(token));
                    } catch (IOException e) {
                        throw new IllegalStateException(e);
                    }
                });
                emitter.send(SseEmitter.event()
                        .name("result")
                        .data(json.writeValueAsString(response), MediaType.APPLICATION_JSON));
                emitter.complete();
            } catch (Exception e) {
                emitter.completeWithError(e);
            }
        });
        return emitter;
    }

    private static AssistantService.AskRequest toRequest(AskBody body) {
        AskBody safe = body == null
                ? new AskBody(null, null, null, null, null, null, null, null, null, null, List.of())
                : body;
        return new AssistantService.AskRequest(
                safe.conversationId(),
                safe.question(),
                safe.intent(),
                new ContextRetrievalService.AskContext(
                        safe.view(),
                        safe.focusedFile(),
                        safe.focusedNodeId(),
                        safe.focusedCommitSha(),
                        safe.focusedFindingId(),
                        safe.focusedNoteId(),
                        safe.focusedTaskId(),
                        safe.selectedAreas() == null ? List.of() : safe.selectedAreas()));
    }
}
