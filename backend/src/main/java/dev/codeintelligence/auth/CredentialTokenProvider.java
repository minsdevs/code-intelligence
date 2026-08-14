package dev.codeintelligence.auth;

import dev.codeintelligence.common.security.CredentialKind;
import dev.codeintelligence.github.GithubTokenProvider;
import java.util.Optional;
import org.springframework.stereotype.Component;

@Component
public class CredentialTokenProvider implements GithubTokenProvider {

    private final GithubCredentialRepository credentialRepository;
    private final TokenCryptoService tokenCryptoService;

    public CredentialTokenProvider(
            GithubCredentialRepository credentialRepository, TokenCryptoService tokenCryptoService) {
        this.credentialRepository = credentialRepository;
        this.tokenCryptoService = tokenCryptoService;
    }

    @Override
    public Optional<String> findToken(long userId) {
        return credentialRepository
                .findByUserIdAndKind(userId, CredentialKind.OAUTH)
                .or(() -> credentialRepository.findByUserIdAndKind(userId, CredentialKind.PAT))
                .map(credential -> tokenCryptoService.decrypt(
                        credential.getKeyVersion(), credential.getNonce(), credential.getEncryptedToken()));
    }

    @Override
    public String requireToken(long userId) {
        return findToken(userId).orElseThrow(MissingCredentialException::new);
    }
}
