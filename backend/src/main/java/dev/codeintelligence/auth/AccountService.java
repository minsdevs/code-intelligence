package dev.codeintelligence.auth;

import dev.codeintelligence.github.GithubUserInfo;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AccountService {

    private final UserAccountRepository userAccountRepository;
    private final GithubCredentialRepository githubCredentialRepository;
    private final TokenCryptoService tokenCryptoService;

    public AccountService(
            UserAccountRepository userAccountRepository,
            GithubCredentialRepository githubCredentialRepository,
            TokenCryptoService tokenCryptoService) {
        this.userAccountRepository = userAccountRepository;
        this.githubCredentialRepository = githubCredentialRepository;
        this.tokenCryptoService = tokenCryptoService;
    }

    @Transactional
    public UserAccount upsertUserWithCredential(GithubUserInfo profile, CredentialKind kind, String rawToken) {
        UserAccount user = userAccountRepository
                .findByGithubId(profile.id())
                .map(existing -> {
                    existing.updateProfile(profile.login(), profile.name(), profile.avatarUrl());
                    return existing;
                })
                .orElseGet(() -> userAccountRepository.save(
                        new UserAccount(profile.id(), profile.login(), profile.name(), profile.avatarUrl())));

        EncryptedToken encrypted = tokenCryptoService.encrypt(rawToken);
        githubCredentialRepository
                .findByUserIdAndKind(user.getId(), kind)
                .ifPresentOrElse(
                        credential -> credential.updateToken(encrypted, profile.scopes()),
                        () -> githubCredentialRepository.save(
                                new GithubCredential(user.getId(), kind, encrypted, profile.scopes())));
        return user;
    }
}
