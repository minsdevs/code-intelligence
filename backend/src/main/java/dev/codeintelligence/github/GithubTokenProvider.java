package dev.codeintelligence.github;

import java.util.Optional;

/**
 * Resolves a user's GitHub access token at call time. Implemented by the auth package (dependency
 * inversion keeps github free of auth imports); tokens are decrypted per call and never cached.
 */
public interface GithubTokenProvider {

    /** OAUTH credential wins over PAT; empty when the user has no stored credential. */
    Optional<String> findToken(long userId);

    /** Same resolution, but missing credentials become a 401 ProblemDetail. */
    String requireToken(long userId);
}
