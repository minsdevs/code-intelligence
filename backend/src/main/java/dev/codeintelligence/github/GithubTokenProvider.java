package dev.codeintelligence.github;

import java.util.Optional;
import java.util.function.Consumer;

/**
 * Resolves a user's GitHub access token at call time. Implemented by the auth package (dependency
 * inversion keeps github free of auth imports); tokens are decrypted per call and never cached.
 */
public interface GithubTokenProvider {

    /** OAUTH credential wins over PAT; empty when the user has no stored credential. */
    Optional<String> findToken(long userId);

    /** Same resolution, but missing credentials become a 401 ProblemDetail. */
    String requireToken(long userId);

    default Optional<BorrowedToken> findCredential(long userId) {
        return findToken(userId)
                .map(token -> new BorrowedToken(
                        token,
                        () -> verifyCurrent(userId, token),
                        () -> rejectUsedToken(userId, token),
                        publication -> publishIfCurrent(userId, token, publication)));
    }

    default BorrowedToken requireCredential(long userId) {
        String token = requireToken(userId);
        return new BorrowedToken(
                token,
                () -> verifyCurrent(userId, token),
                () -> rejectUsedToken(userId, token),
                publication -> publishIfCurrent(userId, token, publication));
    }

    /** Backend-only capability; never return this object or its value in an API response. */
    final class BorrowedToken {
        private final String value;
        private final Runnable verification;
        private final Runnable rejection;
        private final Consumer<Runnable> publication;
        private final Runnable transportFailureCheck;

        public BorrowedToken(String value, Runnable verification, Runnable rejection, Consumer<Runnable> publication) {
            this(value, verification, rejection, publication, verification);
        }

        public BorrowedToken(
                String value,
                Runnable verification,
                Runnable rejection,
                Consumer<Runnable> publication,
                Runnable transportFailureCheck) {
            this.value = value;
            this.verification = verification;
            this.rejection = rejection;
            this.publication = publication;
            this.transportFailureCheck = transportFailureCheck;
        }

        public String value() {
            return value;
        }

        public void verify() {
            verification.run();
        }

        public void reject() {
            rejection.run();
        }

        public void publish(Runnable action) {
            publication.accept(action);
        }

        public void checkAfterTransportFailure() {
            transportFailureCheck.run();
        }

        @Override
        public String toString() {
            return "BorrowedGithubToken{REDACTED}";
        }
    }

    /** Verify the borrowed material before a request and before returning its result. */
    default void verifyCurrent(long userId, String token) {}

    /** Only an actual upstream 401 may invalidate the same still-current material. */
    default void rejectUsedToken(long userId, String token) {}

    /** Current auth implementation fences publication against connection replacement. */
    default void publishIfCurrent(long userId, String token, Runnable publication) {
        verifyCurrent(userId, token);
        publication.run();
    }
}
