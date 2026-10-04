package dev.codeintelligence.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

import dev.codeintelligence.common.security.AuthenticatedUser;
import dev.codeintelligence.common.security.CredentialKind;
import dev.codeintelligence.github.GithubUserInfo;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.test.util.ReflectionTestUtils;

class GithubCredentialExpiryTest {
    private static final Instant NOW = Instant.parse("2026-10-05T00:00:00Z");
    private static final Clock CLOCK = Clock.fixed(NOW, ZoneOffset.UTC);
    private static final EncryptedToken ENCRYPTED = new EncryptedToken(1, new byte[12], "synthetic-ciphertext");
    private final GithubCredentialRepository credentials = mock(GithubCredentialRepository.class);
    private final UserAccountRepository users = mock(UserAccountRepository.class);
    private final TokenCryptoService crypto = mock(TokenCryptoService.class);

    @Test
    void rejectsUnknownAndExpiredOauthWithoutFallingBackToPat() {
        var provider = new CredentialTokenProvider(credentials, crypto, CLOCK);
        for (Instant expiry : new Instant[] {null, NOW.minusSeconds(1), NOW}) {
            when(credentials.findByUserIdAndKind(7L, CredentialKind.OAUTH))
                    .thenReturn(Optional.of(new GithubCredential(7L, CredentialKind.OAUTH, ENCRYPTED, "", expiry)));
            assertThat(provider.findToken(7L)).isEmpty();
        }
        verify(credentials, never()).findByUserIdAndKind(7L, CredentialKind.PAT);
        verifyNoInteractions(crypto);
    }

    @Test
    void preservesValidOauthAndLegacyPatTokens() {
        var provider = new CredentialTokenProvider(credentials, crypto, CLOCK);
        when(crypto.decrypt(1, ENCRYPTED.nonce(), ENCRYPTED.ciphertext())).thenReturn("synthetic-token");
        when(credentials.findByUserIdAndKind(7L, CredentialKind.OAUTH))
                .thenReturn(
                        Optional.of(new GithubCredential(7L, CredentialKind.OAUTH, ENCRYPTED, "", NOW.plusSeconds(1))));
        assertThat(provider.findToken(7L)).contains("synthetic-token");
        when(credentials.findByUserIdAndKind(7L, CredentialKind.OAUTH)).thenReturn(Optional.empty());
        when(credentials.findByUserIdAndKind(7L, CredentialKind.PAT))
                .thenReturn(Optional.of(new GithubCredential(7L, CredentialKind.PAT, ENCRYPTED, "repo")));
        assertThat(provider.findToken(7L)).contains("synthetic-token");
    }

    @Test
    void storesExpiryAndKeepsLinkedIdentityForExpiredCredentials() {
        var service = new AccountService(users, credentials, crypto, CLOCK);
        UserAccount user = UserAccount.local("fixture-local");
        ReflectionTestUtils.setField(user, "id", 7L);
        when(users.findById(7L)).thenReturn(Optional.of(user));
        when(users.findByGithubId(42L)).thenReturn(Optional.empty());
        when(crypto.encrypt("synthetic-token")).thenReturn(ENCRYPTED);
        GithubCredential credential = new GithubCredential(7L, CredentialKind.OAUTH, ENCRYPTED, "");
        when(credentials.findByUserIdAndKind(7L, CredentialKind.OAUTH)).thenReturn(Optional.of(credential));
        service.linkGithub(
                7L,
                new GithubUserInfo(42L, "fixture-user", "Fixture", null, ""),
                CredentialKind.OAUTH,
                "synthetic-token",
                NOW.plusSeconds(1));
        assertThat(credential.getExpiresAt()).isEqualTo(NOW.plusSeconds(1));
        assertThat(service.status(7L).githubConnected()).isTrue();
        credential.updateToken(ENCRYPTED, "", NOW);
        assertThat(service.status(7L).githubConnected()).isFalse();
        assertThat(service.status(7L).githubId()).isEqualTo(42L);
        assertThat(service.status(7L).reauthenticationReason()).isEqualTo("TOKEN_EXPIRED");
        credential.updateToken(ENCRYPTED, "");
        assertThat(service.status(7L).reauthenticationReason()).isEqualTo("EXPIRY_UNKNOWN");
    }

    @Test
    @SuppressWarnings("unchecked")
    void nativeMeAdvertisesLoginAndConnectedKindWithoutChangingTheLocalPrincipal() {
        ObjectProvider<ClientRegistrationRepository> registrations = mock(ObjectProvider.class);
        var nativeOAuth = mock(GithubNativeOAuthService.class);
        var accounts = mock(AccountService.class);
        when(nativeOAuth.configured()).thenReturn(true);
        var controller = new AuthController(mock(PatAuthService.class), registrations, nativeOAuth, accounts);
        assertThat(controller.me(null).oauthAvailable()).isFalse();
        var principal = new AuthenticatedUser(7L, 42L, "fixture-user", "Fixture", null, CredentialKind.LOCAL);
        when(accounts.status(7L))
                .thenReturn(new AccountService.AccountStatus("LOCAL_LINKED", true, 42L, null, CredentialKind.OAUTH));
        assertThat(controller.me(principal).credentialKind()).isEqualTo("OAUTH");
        assertThat(controller.me(principal).oauthAvailable()).isTrue();
        var browserPrincipal = new AuthenticatedUser(7L, 42L, "fixture-user", "Fixture", null, CredentialKind.OAUTH);
        assertThat(controller.me(browserPrincipal).oauthAvailable()).isFalse();
        when(registrations.getIfAvailable()).thenReturn(mock(ClientRegistrationRepository.class));
        assertThat(controller.me(browserPrincipal).oauthAvailable()).isTrue();
        assertThat(controller.me(null).oauthAvailable()).isTrue();
        assertThat(principal.credentialKind()).isEqualTo(CredentialKind.LOCAL);
        when(accounts.status(7L))
                .thenReturn(new AccountService.AccountStatus("LOCAL_LINKED", false, 42L, "TOKEN_EXPIRED", null));
        assertThat(controller.me(principal).credentialKind()).isEqualTo("LOCAL");
    }
}
