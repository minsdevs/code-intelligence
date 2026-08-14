package dev.codeintelligence.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import dev.codeintelligence.common.security.AuthenticatedUser;
import dev.codeintelligence.common.security.CredentialKind;
import dev.codeintelligence.github.GithubApiClient;
import dev.codeintelligence.github.GithubProperties;
import dev.codeintelligence.github.InvalidGithubTokenException;
import java.util.Optional;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

class PatAuthServiceTest {

    private static final String BASE_URL = "https://api.github.test";
    private static final String VALID_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

    private final RestClient.Builder builder = RestClient.builder();
    private final MockRestServiceServer server =
            MockRestServiceServer.bindTo(builder).build();
    private final GithubApiClient githubApiClient =
            new GithubApiClient(builder, new GithubProperties(BASE_URL, "https://github.com"));

    private final UserAccountRepository userAccountRepository = mock(UserAccountRepository.class);
    private final GithubCredentialRepository credentialRepository = mock(GithubCredentialRepository.class);
    private final TokenCryptoService tokenCryptoService = new TokenCryptoService(new TokenCryptoProperties(VALID_KEY));
    private final AccountService accountService =
            new AccountService(userAccountRepository, credentialRepository, tokenCryptoService);
    private final PatAuthService patAuthService =
            new PatAuthService(githubApiClient, accountService, new HttpSessionSecurityContextRepository());

    private final MockHttpServletRequest request = new MockHttpServletRequest();
    private final MockHttpServletResponse response = new MockHttpServletResponse();

    @AfterEach
    void clearSecurityContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void validPatUpsertsUserStoresEncryptedCredentialAndCreatesSession() {
        expectGithubUser();
        when(userAccountRepository.findByGithubId(42L)).thenReturn(Optional.empty());
        when(userAccountRepository.save(any())).thenAnswer(invocation -> {
            UserAccount account = invocation.getArgument(0);
            ReflectionTestUtils.setField(account, "id", 7L);
            return account;
        });
        when(credentialRepository.findByUserIdAndKind(7L, CredentialKind.PAT)).thenReturn(Optional.empty());
        when(credentialRepository.save(any())).thenAnswer(invocation -> invocation.getArgument(0));

        patAuthService.login("ghp_valid-token", request, response);

        ArgumentCaptor<GithubCredential> credentialCaptor = ArgumentCaptor.forClass(GithubCredential.class);
        verify(credentialRepository).save(credentialCaptor.capture());
        GithubCredential saved = credentialCaptor.getValue();
        assertThat(saved.getKind()).isEqualTo(CredentialKind.PAT);
        assertThat(saved.getKeyVersion()).isEqualTo(1);
        assertThat(saved.getNonce()).hasSize(12);
        assertThat(saved.getScopes()).isEqualTo("repo, read:user");
        assertThat(saved.getEncryptedToken()).doesNotContain("ghp_valid-token");
        assertThat(tokenCryptoService.decrypt(saved.getKeyVersion(), saved.getNonce(), saved.getEncryptedToken()))
                .isEqualTo("ghp_valid-token");
        assertThat(saved.toString()).doesNotContain("ghp_valid-token").doesNotContain(saved.getEncryptedToken());

        SecurityContext stored = (SecurityContext) request.getSession(false)
                .getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY);
        assertThat(stored).isNotNull();
        AuthenticatedUser principal =
                (AuthenticatedUser) stored.getAuthentication().getPrincipal();
        assertThat(principal.userId()).isEqualTo(7L);
        assertThat(principal.login()).isEqualTo("octocat");
        assertThat(principal.credentialKind()).isEqualTo(CredentialKind.PAT);
    }

    @Test
    void existingUserAndCredentialAreUpdatedInPlace() {
        expectGithubUser();
        UserAccount existingUser = new UserAccount(42L, "old-login", null, null);
        ReflectionTestUtils.setField(existingUser, "id", 7L);
        GithubCredential existingCredential =
                new GithubCredential(7L, CredentialKind.PAT, tokenCryptoService.encrypt("ghp_old-token"), null);
        when(userAccountRepository.findByGithubId(42L)).thenReturn(Optional.of(existingUser));
        when(credentialRepository.findByUserIdAndKind(7L, CredentialKind.PAT))
                .thenReturn(Optional.of(existingCredential));

        patAuthService.login("ghp_valid-token", request, response);

        verify(userAccountRepository, never()).save(any());
        verify(credentialRepository, never()).save(any());
        assertThat(existingUser.getLogin()).isEqualTo("octocat");
        assertThat(tokenCryptoService.decrypt(
                        existingCredential.getKeyVersion(),
                        existingCredential.getNonce(),
                        existingCredential.getEncryptedToken()))
                .isEqualTo("ghp_valid-token");
    }

    @Test
    void rejectedPatBecomes400ProblemDetailAndNothingIsPersisted() {
        server.expect(requestTo(BASE_URL + "/user")).andRespond(withStatus(HttpStatus.UNAUTHORIZED));

        assertThatThrownBy(() -> patAuthService.login("ghp_rejected-secret", request, response))
                .isInstanceOf(InvalidGithubTokenException.class)
                .satisfies(e -> {
                    InvalidGithubTokenException ex = (InvalidGithubTokenException) e;
                    assertThat(ex.getStatusCode().value()).isEqualTo(400);
                    assertThat(ex.getBody().getDetail()).doesNotContain("ghp_rejected-secret");
                })
                .hasMessageNotContaining("ghp_rejected-secret");

        verifyNoInteractions(userAccountRepository, credentialRepository);
        assertThat(request.getSession(false)).isNull();
    }

    private void expectGithubUser() {
        HttpHeaders responseHeaders = new HttpHeaders();
        responseHeaders.add("X-OAuth-Scopes", "repo, read:user");
        server.expect(requestTo(BASE_URL + "/user"))
                .andRespond(withSuccess("""
                                {"id":42,"login":"octocat","name":"Octo Cat",
                                 "avatar_url":"https://avatars.test/octocat.png"}""", MediaType.APPLICATION_JSON).headers(responseHeaders));
    }
}
