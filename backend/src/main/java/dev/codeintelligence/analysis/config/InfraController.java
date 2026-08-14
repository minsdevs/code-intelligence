package dev.codeintelligence.analysis.config;

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
public class InfraController {

    private final InfraService infraService;

    public InfraController(InfraService infraService) {
        this.infraService = infraService;
    }

    @GetMapping("/{projectId}/infra")
    public List<InfraService.InfraResourceView> infra(
            @PathVariable long projectId,
            @RequestParam(required = false) Long snapshotId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return infraService.list(projectId, user.userId(), snapshotId);
    }
}
