package dev.codeintelligence.auth;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.constraints.NotBlank;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final PatAuthService patAuthService;
    private final ObjectProvider<ClientRegistrationRepository> clientRegistrations;

    public AuthController(
            PatAuthService patAuthService, ObjectProvider<ClientRegistrationRepository> clientRegistrations) {
        this.patAuthService = patAuthService;
        this.clientRegistrations = clientRegistrations;
    }

    /** permitAll: anonymous callers get 200 {authenticated:false}, never 401. */
    @GetMapping("/me")
    public MeResponse me(@AuthenticationPrincipal AuthenticatedUser user) {
        boolean oauthAvailable = clientRegistrations.getIfAvailable() != null;
        if (user == null) {
            return new MeResponse(false, null, null, null, null, oauthAvailable);
        }
        return new MeResponse(
                true,
                user.login(),
                user.name(),
                user.avatarUrl(),
                user.credentialKind().name(),
                oauthAvailable);
    }

    @PostMapping("/pat")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void registerPat(
            @Validated @RequestBody PatRequest body, HttpServletRequest request, HttpServletResponse response) {
        patAuthService.login(body.token(), request, response);
    }

    public record PatRequest(@NotBlank String token) {}

    public record MeResponse(
            boolean authenticated,
            String login,
            String name,
            String avatarUrl,
            String credentialKind,
            boolean oauthAvailable) {}
}
