package dev.codeintelligence.analysis.coverage;

import dev.codeintelligence.common.security.AuthenticatedUser;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * GET /api/projects/{projectId}/coverage — returns the analysis coverage report
 * for the current snapshot of the given project.
 */
@RestController
@RequestMapping("/api/projects/{projectId}/coverage")
public class CoverageController {

    private final CoverageService coverageService;

    public CoverageController(CoverageService coverageService) {
        this.coverageService = coverageService;
    }

    @GetMapping
    public CoverageReport getCoverage(@PathVariable long projectId, @AuthenticationPrincipal AuthenticatedUser user) {
        return coverageService.getReport(projectId, user.userId());
    }
}
