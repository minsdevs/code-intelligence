package dev.codeintelligence.auth;

import dev.codeintelligence.common.security.AuthenticatedUser;
import dev.codeintelligence.common.security.CredentialKind;
import dev.codeintelligence.github.GithubApiClient;
import dev.codeintelligence.github.GithubUserInfo;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
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
    private final GithubConnectionCoordinator connections;
    private final DesktopAuthProperties desktop;
    private final boolean desktopMode;
    private final SecurityContextHolderStrategy securityContextHolderStrategy =
            SecurityContextHolder.getContextHolderStrategy();

    public PatAuthService(
            GithubApiClient githubApiClient,
            AccountService accountService,
            SecurityContextRepository securityContextRepository) {
        this(
                githubApiClient,
                accountService,
                securityContextRepository,
                new GithubConnectionCoordinator(),
                new DesktopAuthProperties(null, null, null));
    }

    @Autowired
    public PatAuthService(
            GithubApiClient githubApiClient,
            AccountService accountService,
            SecurityContextRepository securityContextRepository,
            GithubConnectionCoordinator connections,
            DesktopAuthProperties desktop,
            Environment environment) {
        this(
                githubApiClient,
                accountService,
                securityContextRepository,
                connections,
                desktop,
                environment.acceptsProfiles(Profiles.of("desktop")));
    }

    public PatAuthService(
            GithubApiClient githubApiClient,
            AccountService accountService,
            SecurityContextRepository securityContextRepository,
            GithubConnectionCoordinator connections,
            DesktopAuthProperties desktop) {
        this(githubApiClient, accountService, securityContextRepository, connections, desktop, desktop.configured());
    }

    private PatAuthService(
            GithubApiClient githubApiClient,
            AccountService accountService,
            SecurityContextRepository securityContextRepository,
            GithubConnectionCoordinator connections,
            DesktopAuthProperties desktop,
            boolean desktopMode) {
        this.githubApiClient = githubApiClient;
        this.accountService = accountService;
        this.securityContextRepository = securityContextRepository;
        this.connections = connections;
        this.desktop = desktop;
        this.desktopMode = desktopMode;
    }

    public void login(String rawToken, HttpServletRequest request, HttpServletResponse response) {
        String token = rawToken.strip();
        if (token.isEmpty() || token.length() > 4096)
            throw new GithubReauthenticationRequiredException("CREDENTIAL_INVALID");
        Authentication current = securityContextHolderStrategy.getContext().getAuthentication();
        if (desktopMode
                || (desktop.configured()
                        && current != null
                        && current.getPrincipal() instanceof AuthenticatedUser localPrincipal
                        && localPrincipal.credentialKind() == CredentialKind.LOCAL)) {
            Authentication authentication = current;
            if (authentication == null
                    || !(authentication.getPrincipal() instanceof AuthenticatedUser principal)
                    || principal.credentialKind() != CredentialKind.LOCAL) throw new MissingCredentialException();
            UserAccount local = accountService.getOrCreateLocal(desktop.localIdentity());
            if (local.getId() != principal.userId())
                throw new GithubReauthenticationRequiredException("CONNECTION_CHANGED");
            var connection = connections.connection(principal.userId());
            long generation;
            synchronized (connection) {
                generation = ++connection.value;
            }
            GithubUserInfo profile = githubApiClient.getUser(token);
            synchronized (connection) {
                if (generation != connection.value)
                    throw new GithubReauthenticationRequiredException("CONNECTION_CHANGED");
                accountService.linkLocalPat(principal.userId(), profile, token);
            }
            // Desktop requests retain the installation-local owner; never replace
            // it with a different GitHub user's browser session principal.
            return;
        }
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
