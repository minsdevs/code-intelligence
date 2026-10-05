package dev.codeintelligence.auth;

import dev.codeintelligence.github.GithubTokenProvider;
import java.util.Optional;
import org.springframework.stereotype.Component;

@Component
public class CredentialTokenProvider implements GithubTokenProvider {

    private final GithubTokenLifecycle lifecycle;

    public CredentialTokenProvider(GithubTokenLifecycle lifecycle) {
        this.lifecycle = lifecycle;
    }

    @Override
    public Optional<String> findToken(long userId) {
        // Only truly absent credentials permit anonymous public-repository import.
        // Expired/rejected/pending stored credentials require reauthentication.
        return lifecycle.findToken(userId);
    }

    @Override
    public String requireToken(long userId) {
        return findToken(userId).orElseThrow(MissingCredentialException::new);
    }

    @Override
    public Optional<BorrowedToken> findCredential(long userId) {
        return lifecycle.borrow(userId);
    }

    @Override
    public BorrowedToken requireCredential(long userId) {
        return lifecycle.borrow(userId).orElseThrow(MissingCredentialException::new);
    }

    @Override
    public void verifyCurrent(long userId, String token) {
        lifecycle.verifyCurrent(userId, token);
    }

    @Override
    public void rejectUsedToken(long userId, String token) {
        lifecycle.rejectUsedToken(userId, token);
    }

    @Override
    public void publishIfCurrent(long userId, String token, Runnable publication) {
        lifecycle.publishIfCurrent(userId, token, publication);
    }
}
