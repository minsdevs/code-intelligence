package dev.codeintelligence.auth;

import dev.codeintelligence.common.security.CredentialKind;
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

    @Transactional
    public UserAccount getOrCreateLocal(String localKey) {
        return userAccountRepository
                .findByLocalKey(localKey)
                .orElseGet(() -> userAccountRepository.save(UserAccount.local(localKey)));
    }

    @Transactional
    public UserAccount linkGithub(long userId, GithubUserInfo profile, CredentialKind kind, String rawToken) {
        UserAccount user = userAccountRepository.findById(userId).orElseThrow();
        userAccountRepository.findByGithubId(profile.id()).ifPresent(existing -> {
            if (!existing.getId().equals(user.getId())) {
                throw new GithubAccountConflictException();
            }
        });
        user.linkGithub(profile.id(), profile.login(), profile.name(), profile.avatarUrl());
        storeCredential(user.getId(), profile, kind, rawToken);
        return user;
    }

    @Transactional
    public void disconnectGithub(long userId) {
        UserAccount user = userAccountRepository.findById(userId).orElseThrow();
        user.disconnectGithub();
        githubCredentialRepository.deleteByUserIdAndKind(userId, CredentialKind.OAUTH);
        githubCredentialRepository.deleteByUserIdAndKind(userId, CredentialKind.PAT);
    }

    public AccountStatus status(long userId) {
        UserAccount user = userAccountRepository.findById(userId).orElseThrow();
        boolean connected = user.getGithubId() != null
                && (githubCredentialRepository
                                .findByUserIdAndKind(userId, CredentialKind.OAUTH)
                                .isPresent()
                        || githubCredentialRepository
                                .findByUserIdAndKind(userId, CredentialKind.PAT)
                                .isPresent());
        return new AccountStatus(user.getIdentityType(), connected, user.getGithubId());
    }

    private void storeCredential(long userId, GithubUserInfo profile, CredentialKind kind, String rawToken) {
        EncryptedToken encrypted = tokenCryptoService.encrypt(rawToken);
        githubCredentialRepository
                .findByUserIdAndKind(userId, kind)
                .ifPresentOrElse(
                        credential -> credential.updateToken(encrypted, profile.scopes()),
                        () -> githubCredentialRepository.save(
                                new GithubCredential(userId, kind, encrypted, profile.scopes())));
    }

    public record AccountStatus(String identityType, boolean githubConnected, Long githubId) {}
}
