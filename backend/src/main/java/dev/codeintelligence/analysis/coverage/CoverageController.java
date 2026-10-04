package dev.codeintelligence.analysis.coverage;

import dev.codeintelligence.common.security.AuthenticatedUser;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * GET /api/projects/{projectId}/coverage — returns the analysis coverage report
 * for an explicitly selected owned snapshot, or the current snapshot when omitted.
 */
@RestController
@RequestMapping("/api/projects/{projectId}/coverage")
public class CoverageController {

    private final CoverageService coverageService;

    public CoverageController(CoverageService coverageService) {
        this.coverageService = coverageService;
    }

    public CoverageReport getCoverage(long projectId, AuthenticatedUser user) {
        return coverageService.getReport(projectId, user.userId());
    }

    @GetMapping
    public CoverageReport getCoverage(
            @PathVariable long projectId,
            @AuthenticationPrincipal AuthenticatedUser user,
            @RequestParam(required = false) Long snapshotId) {
        return coverageService.getReport(projectId, user.userId(), snapshotId);
    }
}
