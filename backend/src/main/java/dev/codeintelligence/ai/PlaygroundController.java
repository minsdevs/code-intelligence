package dev.codeintelligence.ai;

import dev.codeintelligence.common.security.AuthenticatedUser;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/projects/{projectId}/playground/sessions")
public class PlaygroundController {

    private final PlaygroundService playgroundService;

    public PlaygroundController(PlaygroundService playgroundService) {
        this.playgroundService = playgroundService;
    }

    @GetMapping
    public List<PlaygroundService.SessionSummary> list(
            @PathVariable long projectId, @AuthenticationPrincipal AuthenticatedUser user) {
        return playgroundService.list(projectId, user.userId());
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public PlaygroundService.SessionView create(
            @PathVariable long projectId,
            @RequestBody(required = false) PlaygroundService.UpsertSession body,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return playgroundService.create(projectId, user.userId(), body);
    }

    @GetMapping("/{sessionId}")
    public PlaygroundService.SessionView get(
            @PathVariable long projectId,
            @PathVariable long sessionId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return playgroundService.get(projectId, user.userId(), sessionId);
    }

    @PutMapping("/{sessionId}")
    public PlaygroundService.SessionView update(
            @PathVariable long projectId,
            @PathVariable long sessionId,
            @RequestBody PlaygroundService.UpsertSession body,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return playgroundService.update(projectId, user.userId(), sessionId, body);
    }

    @DeleteMapping("/{sessionId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(
            @PathVariable long projectId,
            @PathVariable long sessionId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        playgroundService.delete(projectId, user.userId(), sessionId);
    }

    @PostMapping("/{sessionId}/ask")
    public PlaygroundService.SessionView ask(
            @PathVariable long projectId,
            @PathVariable long sessionId,
            @RequestBody PlaygroundService.AskBody body,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return playgroundService.ask(projectId, user.userId(), sessionId, body);
    }
}
