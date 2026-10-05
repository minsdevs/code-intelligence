package dev.codeintelligence.auth;

import dev.codeintelligence.common.security.CredentialKind;
import dev.codeintelligence.github.GithubUserInfo;
import java.time.Clock;
import java.time.Instant;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AccountService {

    private final UserAccountRepository userAccountRepository;
    private final GithubCredentialRepository githubCredentialRepository;
    private final TokenCryptoService tokenCryptoService;
    private final Clock clock;
    private final GithubDeviceCredentialCodec deviceCodec;
    private final GithubTokenLifecycle tokenLifecycle;

    @Autowired
    public AccountService(
            UserAccountRepository users,
            GithubCredentialRepository credentials,
            TokenCryptoService crypto,
            GithubDeviceCredentialCodec codec,
            GithubTokenLifecycle lifecycle) {
        this(users, credentials, crypto, Clock.systemUTC(), codec, lifecycle);
    }

    public AccountService(
            UserAccountRepository userAccountRepository,
            GithubCredentialRepository githubCredentialRepository,
            TokenCryptoService tokenCryptoService) {
        this(userAccountRepository, githubCredentialRepository, tokenCryptoService, Clock.systemUTC());
    }

    AccountService(
            UserAccountRepository userAccountRepository,
            GithubCredentialRepository githubCredentialRepository,
            TokenCryptoService tokenCryptoService,
            Clock clock) {
        this(userAccountRepository, githubCredentialRepository, tokenCryptoService, clock, null, null);
    }

    AccountService(
            UserAccountRepository userAccountRepository,
            GithubCredentialRepository githubCredentialRepository,
            TokenCryptoService tokenCryptoService,
            Clock clock,
            GithubDeviceCredentialCodec deviceCodec,
            GithubTokenLifecycle tokenLifecycle) {
        this.clock = clock;
        this.userAccountRepository = userAccountRepository;
        this.githubCredentialRepository = githubCredentialRepository;
        this.tokenCryptoService = tokenCryptoService;
        this.deviceCodec = deviceCodec;
        this.tokenLifecycle = tokenLifecycle;
    }

    @Transactional
    public UserAccount upsertUserWithCredential(GithubUserInfo profile, CredentialKind kind, String rawToken) {
        return upsertUserWithCredential(profile, kind, rawToken, null);
    }

    @Transactional
    public UserAccount upsertUserWithCredential(
            GithubUserInfo profile, CredentialKind kind, String rawToken, Instant expiresAt) {
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
                        credential -> credential.updateToken(encrypted, profile.scopes(), expiresAt),
                        () -> githubCredentialRepository.save(
                                new GithubCredential(user.getId(), kind, encrypted, profile.scopes(), expiresAt)));
        return user;
    }

    @Transactional
    public UserAccount getOrCreateLocal(String localKey) {
        return userAccountRepository
                .findByLocalKey(localKey)
                .orElseGet(() -> userAccountRepository.save(UserAccount.local(localKey)));
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public UserAccount linkGithub(long userId, GithubUserInfo profile, CredentialKind kind, String rawToken) {
        return linkGithub(userId, profile, kind, rawToken, null);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public UserAccount linkGithub(
            long userId, GithubUserInfo profile, CredentialKind kind, String rawToken, Instant expiresAt) {
        UserAccount user = userAccountRepository.findById(userId).orElseThrow();
        userAccountRepository.findByGithubId(profile.id()).ifPresent(existing -> {
            if (!existing.getId().equals(user.getId())) {
                throw new GithubAccountConflictException();
            }
        });
        user.linkGithub(profile.id(), profile.login(), profile.name(), profile.avatarUrl());
        storeCredential(user.getId(), profile, kind, rawToken, expiresAt);
        if (kind == CredentialKind.OAUTH) githubCredentialRepository.deleteByUserIdAndKind(userId, CredentialKind.PAT);
        return user;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public UserAccount linkDeviceGithub(
            long userId,
            GithubUserInfo profile,
            String clientId,
            String accessToken,
            Instant accessExpiresAt,
            String refreshToken,
            Instant refreshExpiresAt) {
        if (deviceCodec == null) throw new GithubReauthenticationRequiredException("CREDENTIAL_INVALID");
        UserAccount user = userAccountRepository.findById(userId).orElseThrow();
        userAccountRepository.findByGithubId(profile.id()).ifPresent(existing -> {
            if (!existing.getId().equals(user.getId())) throw new GithubAccountConflictException();
        });
        var envelope = GithubDeviceCredentialCodec.Envelope.active(
                clientId, profile.id(), accessToken, accessExpiresAt, refreshToken, refreshExpiresAt);
        EncryptedToken encrypted = deviceCodec.encrypt(userId, envelope);
        user.linkGithub(profile.id(), profile.login(), profile.name(), profile.avatarUrl());
        storeEncrypted(userId, profile, CredentialKind.OAUTH, encrypted, envelope.accessExpiresAt());
        githubCredentialRepository.deleteByUserIdAndKind(userId, CredentialKind.PAT);
        return user;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public UserAccount linkLocalPat(long userId, GithubUserInfo profile, String token) {
        UserAccount user = userAccountRepository.findById(userId).orElseThrow();
        if (user.getLocalKey() == null) throw new GithubReauthenticationRequiredException("CONNECTION_CHANGED");
        userAccountRepository.findByGithubId(profile.id()).ifPresent(existing -> {
            if (!existing.getId().equals(user.getId())) throw new GithubAccountConflictException();
        });
        user.linkGithub(profile.id(), profile.login(), profile.name(), profile.avatarUrl());
        storeCredential(userId, profile, CredentialKind.PAT, token, null);
        githubCredentialRepository.deleteByUserIdAndKind(userId, CredentialKind.OAUTH);
        return user;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void disconnectGithub(long userId) {
        UserAccount user = userAccountRepository.findById(userId).orElseThrow();
        user.disconnectGithub();
        githubCredentialRepository.deleteByUserIdAndKind(userId, CredentialKind.OAUTH);
        githubCredentialRepository.deleteByUserIdAndKind(userId, CredentialKind.PAT);
    }

    public AccountStatus status(long userId) {
        UserAccount user = userAccountRepository.findById(userId).orElseThrow();
        boolean linked = user.getGithubId() != null;
        var credential = githubCredentialRepository
                .findByUserIdAndKind(userId, CredentialKind.OAUTH)
                .or(() -> githubCredentialRepository.findByUserIdAndKind(userId, CredentialKind.PAT));
        String reason = !linked
                ? null
                : credential.isEmpty()
                        ? "CREDENTIAL_MISSING"
                        : tokenLifecycle == null
                                ? credential.get().reauthenticationReason(clock.instant())
                                : tokenLifecycle.reauthenticationReason(credential.get(), user.getGithubId());
        boolean connected = linked && credential.isPresent() && reason == null;
        return new AccountStatus(
                user.getIdentityType(),
                connected,
                user.getGithubId(),
                reason,
                connected ? credential.get().getKind() : null);
    }

    private void storeCredential(
            long userId, GithubUserInfo profile, CredentialKind kind, String rawToken, Instant expiresAt) {
        EncryptedToken encrypted = tokenCryptoService.encrypt(rawToken);
        storeEncrypted(userId, profile, kind, encrypted, expiresAt);
    }

    private void storeEncrypted(
            long userId, GithubUserInfo profile, CredentialKind kind, EncryptedToken encrypted, Instant expiresAt) {
        githubCredentialRepository
                .findByUserIdAndKind(userId, kind)
                .ifPresentOrElse(
                        credential -> credential.updateToken(encrypted, profile.scopes(), expiresAt),
                        () -> githubCredentialRepository.save(
                                new GithubCredential(userId, kind, encrypted, profile.scopes(), expiresAt)));
    }

    public record AccountStatus(
            String identityType,
            boolean githubConnected,
            Long githubId,
            String reauthenticationReason,
            CredentialKind credentialKind) {}
}
