package dev.codeintelligence.project;

import com.fasterxml.jackson.annotation.JsonInclude;
import dev.codeintelligence.common.security.AuthenticatedUser;
import dev.codeintelligence.common.security.CredentialKind;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/desktop/paths")
public class DesktopPathAuthorizationController {

    private final DesktopPathAuthorizationService authorizations;
    private final String pathToken;

    public DesktopPathAuthorizationController(
            DesktopPathAuthorizationService authorizations, @Value("${app.desktop.path-token:}") String pathToken) {
        this.authorizations = authorizations;
        this.pathToken = pathToken;
    }

    @PostMapping
    public AuthorizedPath authorize(
            @RequestBody AuthorizePath request,
            @AuthenticationPrincipal AuthenticatedUser user,
            @RequestHeader(value = "X-Code-Intelligence-Path-Token", required = false) String providedToken) {
        if (user.credentialKind() != CredentialKind.LOCAL
                || pathToken.isBlank()
                || providedToken == null
                || !MessageDigest.isEqual(
                        pathToken.getBytes(StandardCharsets.UTF_8), providedToken.getBytes(StandardCharsets.UTF_8))) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Native folder selection is required.");
        }
        if (request.path() == null || request.path().isBlank())
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "A folder path is required.");
        if (request.purpose() == null || request.purpose().equals("SELECT")) {
            DesktopPathAuthorizationService.Grant grant = authorizations.authorize(Path.of(request.path()));
            return new AuthorizedPath(grant.path().toString(), grant.nonce(), grant.expiresAt());
        }
        if (request.purpose().equals("RESTORE")) {
            return new AuthorizedPath(
                    authorizations.restore(Path.of(request.path())).toString(), null, null);
        }
        throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unknown folder authorization purpose.");
    }

    /** SELECT (default): a native-dialog result; RESTORE: a root main persisted for an existing project. */
    public record AuthorizePath(String path, String purpose) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record AuthorizedPath(String path, String grant, Instant expiresAt) {}
}
