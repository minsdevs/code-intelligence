package dev.codeintelligence.auth;

import dev.codeintelligence.github.GithubApiClient;
import dev.codeintelligence.github.GithubUserInfo;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.core.context.SecurityContextHolderStrategy;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.stereotype.Service;

/**
 * First-class login path when no OAuth App is configured: validate the PAT against GitHub
 * GET /user, upsert user + encrypted credential (kind=PAT), then establish a server session.
 */
@Service
public class PatAuthService {

    private final GithubApiClient githubApiClient;
    private final AccountService accountService;
    private final SecurityContextRepository securityContextRepository;
    private final SecurityContextHolderStrategy securityContextHolderStrategy =
            SecurityContextHolder.getContextHolderStrategy();

    public PatAuthService(
            GithubApiClient githubApiClient,
            AccountService accountService,
            SecurityContextRepository securityContextRepository) {
        this.githubApiClient = githubApiClient;
        this.accountService = accountService;
        this.securityContextRepository = securityContextRepository;
    }

    public void login(String rawToken, HttpServletRequest request, HttpServletResponse response) {
        String token = rawToken.strip();
        GithubUserInfo profile = githubApiClient.getUser(token);
        UserAccount user = accountService.upsertUserWithCredential(profile, CredentialKind.PAT, token);

        AuthenticatedUser principal = new AuthenticatedUser(
                user.getId(), profile.id(), profile.login(), profile.name(), profile.avatarUrl(), CredentialKind.PAT);
        Authentication authentication =
                UsernamePasswordAuthenticationToken.authenticated(principal, null, principal.getAuthorities());

        // Session fixation defense for the programmatic login path.
        HttpSession existingSession = request.getSession(false);
        if (existingSession != null) {
            request.changeSessionId();
        }

        SecurityContext context = securityContextHolderStrategy.createEmptyContext();
        context.setAuthentication(authentication);
        securityContextHolderStrategy.setContext(context);
        securityContextRepository.saveContext(context, request, response);
    }
}
