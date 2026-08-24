package dev.codeintelligence.analysis.compare;

import dev.codeintelligence.common.security.AuthenticatedUser;
import java.util.List;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/projects/{projectId}/snapshots")
public class SnapshotComparisonController {

    private final SnapshotComparisonService service;

    public SnapshotComparisonController(SnapshotComparisonService service) {
        this.service = service;
    }

    @GetMapping
    public List<SnapshotComparisonService.SnapshotOption> snapshots(
            @PathVariable long projectId, @AuthenticationPrincipal AuthenticatedUser user) {
        return service.list(projectId, user.userId());
    }

    @GetMapping("/compare")
    public SnapshotComparisonService.SnapshotComparison compare(
            @PathVariable long projectId,
            @RequestParam long baseSnapshotId,
            @RequestParam long targetSnapshotId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return service.compare(projectId, user.userId(), baseSnapshotId, targetSnapshotId);
    }
}
