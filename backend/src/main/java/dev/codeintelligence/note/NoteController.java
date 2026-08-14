package dev.codeintelligence.note;

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
@RequestMapping("/api/projects/{projectId}/notes")
public class NoteController {

    private final NoteService noteService;

    public NoteController(NoteService noteService) {
        this.noteService = noteService;
    }

    @GetMapping
    public List<NoteService.NoteSummary> list(
            @PathVariable long projectId, @AuthenticationPrincipal AuthenticatedUser user) {
        return noteService.list(projectId, user.userId());
    }

    @GetMapping("/{noteId}")
    public NoteService.NoteView get(
            @PathVariable long projectId, @PathVariable long noteId, @AuthenticationPrincipal AuthenticatedUser user) {
        return noteService.get(projectId, user.userId(), noteId);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public NoteService.NoteView create(
            @PathVariable long projectId,
            @RequestBody NoteService.UpsertNote body,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return noteService.create(projectId, user.userId(), body);
    }

    @PutMapping("/{noteId}")
    public NoteService.NoteView update(
            @PathVariable long projectId,
            @PathVariable long noteId,
            @RequestBody NoteService.UpsertNote body,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return noteService.update(projectId, user.userId(), noteId, body);
    }

    @DeleteMapping("/{noteId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(
            @PathVariable long projectId, @PathVariable long noteId, @AuthenticationPrincipal AuthenticatedUser user) {
        noteService.delete(projectId, user.userId(), noteId);
    }
}
