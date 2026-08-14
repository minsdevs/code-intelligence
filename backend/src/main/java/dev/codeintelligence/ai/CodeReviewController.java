package dev.codeintelligence.ai;

import dev.codeintelligence.common.security.AuthenticatedUser;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class CodeReviewController {

    private final CodeReviewService codeReviewService;

    public CodeReviewController(CodeReviewService codeReviewService) {
        this.codeReviewService = codeReviewService;
    }

    @GetMapping("/api/projects/{projectId}/pulls/{number}/review")
    public CodeReviewService.ReviewView latest(
            @PathVariable long projectId, @PathVariable int number, @AuthenticationPrincipal AuthenticatedUser user) {
        return codeReviewService.latest(projectId, user.userId(), number);
    }

    @PostMapping("/api/projects/{projectId}/pulls/{number}/review")
    @ResponseStatus(HttpStatus.CREATED)
    public CodeReviewService.ReviewView generate(
            @PathVariable long projectId, @PathVariable int number, @AuthenticationPrincipal AuthenticatedUser user) {
        return codeReviewService.generate(projectId, user.userId(), number);
    }
}
