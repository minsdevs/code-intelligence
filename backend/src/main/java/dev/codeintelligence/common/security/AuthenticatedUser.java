package dev.codeintelligence.common.security;

import java.io.Serializable;
import java.util.Collection;
import java.util.LinkedHashMap;
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
        long userId, Long githubId, String login, String name, String avatarUrl, CredentialKind credentialKind)
        implements OAuth2User, Serializable {

    @Override
    public Map<String, Object> getAttributes() {
        Map<String, Object> attributes = new LinkedHashMap<>();
        if (githubId != null) {
            attributes.put("id", githubId);
        }
        attributes.put("login", login);
        return Map.copyOf(attributes);
    }

    @Override
    public Collection<? extends GrantedAuthority> getAuthorities() {
        return List.of(new SimpleGrantedAuthority("ROLE_USER"));
    }

    @Override
    public String getName() {
        return githubId == null ? "local:" + userId : String.valueOf(githubId);
    }
}
