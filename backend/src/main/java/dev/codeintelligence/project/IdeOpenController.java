package dev.codeintelligence.project;

import dev.codeintelligence.common.security.AuthenticatedUser;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * POST /api/projects/{projectId}/ide/open — generates an IDE-launch URI
 * for the given file and line in a local project.
 */
@RestController
@RequestMapping("/api/projects/{projectId}/ide")
public class IdeOpenController {

    public record IdeOpenBody(String filePath, int line, String ide) {}

    private final IdeOpenService ideOpenService;

    public IdeOpenController(IdeOpenService ideOpenService) {
        this.ideOpenService = ideOpenService;
    }

    @PostMapping("/open")
    public IdeOpenService.IdeOpenResponse open(
            @PathVariable long projectId,
            @RequestBody IdeOpenBody body,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return ideOpenService.open(
                projectId, user.userId(), new IdeOpenService.IdeOpenRequest(body.filePath(), body.line(), body.ide()));
    }
}
