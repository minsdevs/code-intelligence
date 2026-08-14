package dev.codeintelligence.growth;

import dev.codeintelligence.common.security.AuthenticatedUser;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class GrowthController {

    private final GrowthService growthService;

    public GrowthController(GrowthService growthService) {
        this.growthService = growthService;
    }

    @GetMapping("/api/projects/{projectId}/growth")
    public GrowthService.GrowthView growth(
            @PathVariable long projectId, @AuthenticationPrincipal AuthenticatedUser user) {
        return growthService.report(projectId, user.userId());
    }
}
