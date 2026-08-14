package dev.codeintelligence.analysis.graph;

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
public class ArchitectureController {

    private final ArchitectureService architectureService;

    public ArchitectureController(ArchitectureService architectureService) {
        this.architectureService = architectureService;
    }

    @GetMapping("/{projectId}/endpoints")
    public List<ArchitectureService.EndpointView> endpoints(
            @PathVariable long projectId,
            @RequestParam(required = false) Long snapshotId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return architectureService.endpoints(projectId, user.userId(), snapshotId);
    }

    @GetMapping("/{projectId}/entities")
    public List<ArchitectureService.EntityView> entities(
            @PathVariable long projectId,
            @RequestParam(required = false) Long snapshotId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return architectureService.entities(projectId, user.userId(), snapshotId);
    }

    @GetMapping("/{projectId}/architecture")
    public ArchitectureService.ArchitectureView architecture(
            @PathVariable long projectId,
            @RequestParam(required = false) String area,
            @RequestParam(required = false) Long snapshotId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return architectureService.architecture(projectId, user.userId(), snapshotId, area);
    }
}
