package dev.codeintelligence.analysis.flow;

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
public class FlowController {

    private final FlowService flowService;

    public FlowController(FlowService flowService) {
        this.flowService = flowService;
    }

    @GetMapping("/{projectId}/flows")
    public List<FlowService.FlowSummary> flows(
            @PathVariable long projectId,
            @RequestParam(required = false) String kind,
            @RequestParam(required = false) Long snapshotId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return flowService.list(projectId, user.userId(), snapshotId, kind);
    }

    @GetMapping("/{projectId}/flows/{flowId}")
    public FlowService.FlowDetail flow(
            @PathVariable long projectId,
            @PathVariable long flowId,
            @RequestParam(required = false) Long snapshotId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return flowService.detail(projectId, user.userId(), flowId, snapshotId);
    }
}
