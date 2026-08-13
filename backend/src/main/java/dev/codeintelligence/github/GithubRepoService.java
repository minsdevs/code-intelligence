package dev.codeintelligence.github;

import dev.codeintelligence.auth.CredentialKind;
import dev.codeintelligence.auth.GithubCredential;
import dev.codeintelligence.auth.GithubCredentialRepository;
import dev.codeintelligence.auth.MissingCredentialException;
import dev.codeintelligence.auth.TokenCryptoService;
import java.util.List;
import java.util.Locale;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

@Service
public class GithubRepoService {

    private final GithubCredentialRepository credentialRepository;
    private final TokenCryptoService tokenCryptoService;
    private final GithubApiClient githubApiClient;

    public GithubRepoService(
            GithubCredentialRepository credentialRepository,
            TokenCryptoService tokenCryptoService,
            GithubApiClient githubApiClient) {
        this.credentialRepository = credentialRepository;
        this.tokenCryptoService = tokenCryptoService;
        this.githubApiClient = githubApiClient;
    }

    /** OAUTH credential wins over PAT when both exist. q filters within the fetched page. */
    public GithubRepoPage listRepos(long userId, int page, int perPage, String q) {
        GithubCredential credential = credentialRepository
                .findByUserIdAndKind(userId, CredentialKind.OAUTH)
                .or(() -> credentialRepository.findByUserIdAndKind(userId, CredentialKind.PAT))
                .orElseThrow(MissingCredentialException::new);

        String token = tokenCryptoService.decrypt(
                credential.getKeyVersion(), credential.getNonce(), credential.getEncryptedToken());
        GithubRepoPage repoPage = githubApiClient.listUserRepos(token, page, perPage);

        if (!StringUtils.hasText(q)) {
            return repoPage;
        }
        String needle = q.toLowerCase(Locale.ROOT);
        List<GithubRepoSummary> filtered = repoPage.items().stream()
                .filter(repo -> repo.fullName() != null
                        && repo.fullName().toLowerCase(Locale.ROOT).contains(needle))
                .toList();
        return new GithubRepoPage(filtered, repoPage.hasNext());
    }
}
