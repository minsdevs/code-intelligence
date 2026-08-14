package dev.codeintelligence.analysis.feature;

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
public class FeatureController {

    private final FeatureService featureService;

    public FeatureController(FeatureService featureService) {
        this.featureService = featureService;
    }

    @GetMapping("/{projectId}/features")
    public List<FeatureService.FeatureChildView> features(
            @PathVariable long projectId,
            @RequestParam(required = false) Long snapshotId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return featureService.list(projectId, user.userId(), snapshotId);
    }

    @GetMapping("/{projectId}/features/{featureId}")
    public FeatureService.FeatureDetailView feature(
            @PathVariable long projectId,
            @PathVariable long featureId,
            @RequestParam(required = false) Long snapshotId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return featureService.detail(projectId, user.userId(), featureId, snapshotId);
    }
}
