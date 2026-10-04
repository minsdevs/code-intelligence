package dev.codeintelligence.auth;

import dev.codeintelligence.common.security.AuthenticatedUser;
import dev.codeintelligence.common.security.CredentialKind;
import dev.codeintelligence.github.GithubUserInfo;
import java.util.Map;
import org.springframework.security.oauth2.client.userinfo.DefaultOAuth2UserService;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserRequest;
import org.springframework.security.oauth2.core.OAuth2AccessToken;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.oauth2.core.user.OAuth2User;
import org.springframework.stereotype.Service;

/** On OAuth login: upsert the user row and store the encrypted access token (kind=OAUTH). */
@Service
public class GithubOAuth2UserService extends DefaultOAuth2UserService {

    private final AccountService accountService;

    public GithubOAuth2UserService(AccountService accountService) {
        this.accountService = accountService;
    }

    @Override
    public OAuth2User loadUser(OAuth2UserRequest userRequest) throws OAuth2AuthenticationException {
        OAuth2User oauth2User = super.loadUser(userRequest);
        Map<String, Object> attributes = oauth2User.getAttributes();
        long githubId = ((Number) attributes.get("id")).longValue();
        String login = (String) attributes.get("login");
        String name = (String) attributes.get("name");
        String avatarUrl = (String) attributes.get("avatar_url");

        OAuth2AccessToken accessToken = userRequest.getAccessToken();
        String scopes =
                accessToken.getScopes() == null || accessToken.getScopes().isEmpty()
                        ? null
                        : String.join(",", accessToken.getScopes());

        GithubUserInfo profile = new GithubUserInfo(githubId, login, name, avatarUrl, scopes);
        UserAccount user = accountService.upsertUserWithCredential(
                profile, CredentialKind.OAUTH, accessToken.getTokenValue(), accessToken.getExpiresAt());

        return new AuthenticatedUser(user.getId(), githubId, login, name, avatarUrl, CredentialKind.OAUTH);
    }
}
