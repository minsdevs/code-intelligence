package dev.codeintelligence.history;

import dev.codeintelligence.common.security.AuthenticatedUser;
import java.util.List;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/projects")
public class HistoryController {

    private final HistoryService historyService;
    private final EraService eraService;

    public HistoryController(HistoryService historyService, EraService eraService) {
        this.historyService = historyService;
        this.eraService = eraService;
    }

    @GetMapping("/{projectId}/commits")
    public List<CommitSummary> commits(
            @PathVariable long projectId,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) String branch,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return historyService.listCommits(projectId, user.userId(), page, branch);
    }

    @GetMapping("/{projectId}/commits/{sha}")
    public CommitDetail commit(
            @PathVariable long projectId, @PathVariable String sha, @AuthenticationPrincipal AuthenticatedUser user) {
        return historyService.commitDetail(projectId, user.userId(), sha);
    }

    @GetMapping("/{projectId}/commits/{sha}/diff")
    public CommitDiff diff(
            @PathVariable long projectId,
            @PathVariable String sha,
            @RequestParam String path,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return historyService.diff(projectId, user.userId(), sha, path);
    }

    @GetMapping("/{projectId}/branches")
    public List<RefView> branches(@PathVariable long projectId, @AuthenticationPrincipal AuthenticatedUser user) {
        return historyService.branches(projectId, user.userId());
    }

    @GetMapping("/{projectId}/tags")
    public List<RefView> tags(@PathVariable long projectId, @AuthenticationPrincipal AuthenticatedUser user) {
        return historyService.tags(projectId, user.userId());
    }

    @GetMapping("/{projectId}/eras")
    public List<EraService.EraView> eras(
            @PathVariable long projectId, @AuthenticationPrincipal AuthenticatedUser user) {
        return eraService.list(projectId, user.userId());
    }

    @GetMapping("/{projectId}/pulls")
    public List<PullView> pulls(
            @PathVariable long projectId,
            @RequestParam(required = false) String state,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return historyService.pulls(projectId, user.userId(), state);
    }
}
