package dev.codeintelligence.auth;

import dev.codeintelligence.common.security.AuthenticatedUser;
import java.util.UUID;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/auth/github")
public class GithubNativeOAuthController {

    private final GithubNativeOAuthService oauth;
    private final AccountService accounts;

    public GithubNativeOAuthController(GithubNativeOAuthService oauth, AccountService accounts) {
        this.oauth = oauth;
        this.accounts = accounts;
    }

    @PostMapping("/native/start")
    public GithubNativeOAuthService.StartResult start(@AuthenticationPrincipal AuthenticatedUser user) {
        return oauth.start(user.userId());
    }

    @PostMapping("/native/poll/{attemptId}")
    public GithubNativeOAuthService.StatusResult poll(
            @AuthenticationPrincipal AuthenticatedUser user, @PathVariable UUID attemptId) {
        return oauth.poll(user.userId(), attemptId);
    }

    @PostMapping("/native/cancel/{attemptId}")
    public GithubNativeOAuthService.StatusResult cancel(
            @AuthenticationPrincipal AuthenticatedUser user, @PathVariable UUID attemptId) {
        return oauth.cancel(user.userId(), attemptId);
    }

    @GetMapping("/connection")
    public ConnectionResponse connection(@AuthenticationPrincipal AuthenticatedUser user) {
        AccountService.AccountStatus status = accounts.status(user.userId());
        return new ConnectionResponse(
                status.identityType(),
                status.githubConnected(),
                status.githubId(),
                oauth.configured(),
                oauth.revocationUrl());
    }

    /** Removes local credentials only. GitHub-side authorization is a separate user action. */
    @DeleteMapping("/connection")
    public ConnectionResponse disconnect(@AuthenticationPrincipal AuthenticatedUser user) {
        oauth.disconnect(user.userId());
        return connection(user);
    }

    public record ConnectionResponse(
            String identityType,
            boolean connected,
            Long githubId,
            boolean oauthAvailable,
            String githubRevocationUrl) {}
}
