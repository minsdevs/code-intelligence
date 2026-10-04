package dev.codeintelligence.auth;

import dev.codeintelligence.common.security.CredentialKind;
import dev.codeintelligence.github.GithubTokenProvider;
import java.time.Clock;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

@Component
public class CredentialTokenProvider implements GithubTokenProvider {

    private final GithubCredentialRepository credentialRepository;
    private final TokenCryptoService tokenCryptoService;
    private final Clock clock;

    @Autowired
    public CredentialTokenProvider(
            GithubCredentialRepository credentialRepository, TokenCryptoService tokenCryptoService) {
        this(credentialRepository, tokenCryptoService, Clock.systemUTC());
    }

    CredentialTokenProvider(
            GithubCredentialRepository credentialRepository, TokenCryptoService tokenCryptoService, Clock clock) {
        this.clock = clock;
        this.credentialRepository = credentialRepository;
        this.tokenCryptoService = tokenCryptoService;
    }

    @Override
    public Optional<String> findToken(long userId) {
        return credentialRepository
                .findByUserIdAndKind(userId, CredentialKind.OAUTH)
                .or(() -> credentialRepository.findByUserIdAndKind(userId, CredentialKind.PAT))
                // Choose OAuth before filtering: an expired OAuth token must never fall back to PAT.
                .filter(credential -> credential.reauthenticationReason(clock.instant()) == null)
                .map(credential -> tokenCryptoService.decrypt(
                        credential.getKeyVersion(), credential.getNonce(), credential.getEncryptedToken()));
    }

    @Override
    public String requireToken(long userId) {
        return findToken(userId).orElseThrow(MissingCredentialException::new);
    }
}
