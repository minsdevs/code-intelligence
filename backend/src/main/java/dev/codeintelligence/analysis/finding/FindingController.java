package dev.codeintelligence.analysis.finding;

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
public class FindingController {

    private final FindingService findingService;

    public FindingController(FindingService findingService) {
        this.findingService = findingService;
    }

    @GetMapping("/{projectId}/findings")
    public List<FindingService.FindingView> findings(
            @PathVariable long projectId,
            @RequestParam(required = false) String severity,
            @RequestParam(required = false) Long snapshotId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return findingService.list(projectId, user.userId(), snapshotId, severity);
    }
}
