package dev.codeintelligence.common.security;

import java.io.Serializable;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.core.user.OAuth2User;

/**
 * Session principal shared by both login paths (OAuth2 login and PAT registration). Implements
 * OAuth2User so oauth2Login can use it directly; must stay Serializable for Spring Session Redis.
 * Lives in common.security because every API package needs it for owner scoping.
 */
public record AuthenticatedUser(
        long userId, long githubId, String login, String name, String avatarUrl, CredentialKind credentialKind)
        implements OAuth2User, Serializable {

    @Override
    public Map<String, Object> getAttributes() {
        return Map.of("id", githubId, "login", login);
    }

    @Override
    public Collection<? extends GrantedAuthority> getAuthorities() {
        return List.of(new SimpleGrantedAuthority("ROLE_USER"));
    }

    @Override
    public String getName() {
        return String.valueOf(githubId);
    }
}
