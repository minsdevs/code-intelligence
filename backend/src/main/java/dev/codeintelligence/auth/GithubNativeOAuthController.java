package dev.codeintelligence.auth;

import dev.codeintelligence.common.security.AuthenticatedUser;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
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

    @GetMapping("/native/status/{attemptId}")
    public GithubNativeOAuthService.StatusResult status(
            @AuthenticationPrincipal AuthenticatedUser user, @PathVariable UUID attemptId) {
        return oauth.status(user.userId(), attemptId);
    }

    @PostMapping("/native/cancel/{attemptId}")
    public GithubNativeOAuthService.StatusResult cancel(
            @AuthenticationPrincipal AuthenticatedUser user, @PathVariable UUID attemptId) {
        return oauth.cancel(user.userId(), attemptId);
    }

    @GetMapping(value = "/native/callback", produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> callback(
            @RequestParam(required = false) String code,
            @RequestParam(required = false) String state,
            @RequestParam(required = false) String error) {
        GithubNativeOAuthService.CallbackResult result = oauth.callback(code, state, error);
        String title = result.status() == GithubNativeOAuthService.Status.CONNECTED
                ? "GitHub connected"
                : "GitHub login not completed";
        String html = """
                <!doctype html><html><head><meta charset="utf-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
                <meta name="viewport" content="width=device-width,initial-scale=1">
                <title>%s</title><style>body{font:16px system-ui;margin:4rem;max-width:42rem}p{line-height:1.5}</style>
                </head><body><h1>%s</h1><p>%s</p><p>You may close this window.</p></body></html>
                """.formatted(title, title, result.message());
        return ResponseEntity.ok()
                .header("Cache-Control", "no-store")
                .header("Referrer-Policy", "no-referrer")
                .body(html);
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
        accounts.disconnectGithub(user.userId());
        return connection(user);
    }

    public record ConnectionResponse(
            String identityType,
            boolean connected,
            Long githubId,
            boolean oauthAvailable,
            String githubRevocationUrl) {}
}
