package dev.codeintelligence.project;

import dev.codeintelligence.common.security.AuthenticatedUser;
import dev.codeintelligence.common.security.CredentialKind;
import java.nio.file.Path;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/desktop/paths")
public class DesktopPathAuthorizationController {

    private final DesktopPathAuthorizationService authorizations;

    public DesktopPathAuthorizationController(DesktopPathAuthorizationService authorizations) {
        this.authorizations = authorizations;
    }

    @PostMapping
    public AuthorizedPath authorize(
            @RequestBody AuthorizePath request, @AuthenticationPrincipal AuthenticatedUser user) {
        if (user.credentialKind() != CredentialKind.LOCAL) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Native folder selection is required.");
        }
        Path canonical = authorizations.authorize(Path.of(request.path()));
        return new AuthorizedPath(canonical.toString());
    }

    public record AuthorizePath(String path) {}

    public record AuthorizedPath(String path) {}
}
