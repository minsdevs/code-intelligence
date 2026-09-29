package dev.codeintelligence.github;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.codeintelligence.common.AppProperties;
import dev.codeintelligence.testsupport.GitRepoFixtures;
import java.nio.file.Files;
import java.nio.file.Path;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.RefUpdate;
import org.eclipse.jgit.lib.Repository;
import org.eclipse.jgit.storage.file.FileRepositoryBuilder;
import org.eclipse.jgit.transport.CredentialItem;
import org.eclipse.jgit.transport.URIish;
import org.eclipse.jgit.transport.UsernamePasswordCredentialsProvider;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class GitCloneServiceTest {

    @TempDir
    Path temp;

    private GitCloneService service;
    private Path reposRoot;

    @BeforeEach
    void setUp() {
        AppProperties properties = new AppProperties(temp.resolve("data").toString(), 2);
        reposRoot = properties.reposRoot();
        service = new GitCloneService(properties);
    }

    @Test
    void clonesOnFirstRunAndReusesTheCloneWithFetchAfterwards() throws Exception {
        Path origin = temp.resolve("origin");
        String firstSha = GitRepoFixtures.createBareRepoWithCommit(origin, "octocat", "demo");
        Path bare = origin.resolve("octocat/demo.git");
        Path target = reposRoot.resolve("1");

        GitCloneService.CloneResult first =
                service.cloneOrFetch(target, bare.toUri().toString(), null, null);
        assertThat(first.headSha()).isEqualTo(firstSha);
        assertThat(first.branch()).isEqualTo("main");
        assertThat(target.resolve(".git")).isDirectory();
        assertThat(target.resolve("README.md")).exists();

        Path marker = target.resolve(".git").resolve("test-marker");
        Files.writeString(marker, "still the same clone");
        String secondSha = GitRepoFixtures.addCommit(bare, "second.txt", "more content");

        GitCloneService.CloneResult second =
                service.cloneOrFetch(target, bare.toUri().toString(), null, "main");
        assertThat(second.headSha()).isEqualTo(secondSha).isNotEqualTo(firstSha);
        assertThat(marker).as("fetch must reuse the existing clone").exists();
        assertThat(target.resolve("second.txt")).exists();
    }

    @Test
    void clonesTheSelectedBranchOnFirstImport() throws Exception {
        Path origin = temp.resolve("branch-origin");
        String sha = GitRepoFixtures.createBareRepoWithCommit(origin, "octocat", "branched");
        Path bare = origin.resolve("octocat/branched.git");
        try (Repository repository =
                new FileRepositoryBuilder().setGitDir(bare.toFile()).setBare().build()) {
            RefUpdate update = repository.updateRef("refs/heads/release");
            update.setNewObjectId(ObjectId.fromString(sha));
            assertThat(update.update()).isEqualTo(RefUpdate.Result.NEW);
        }

        GitCloneService.CloneResult result =
                service.cloneOrFetch(reposRoot.resolve("selected"), bare.toUri().toString(), null, "release");

        assertThat(result.branch()).isEqualTo("release");
        assertThat(result.headSha()).isEqualTo(sha);
    }

    @Test
    void rejectsTargetsOutsideTheReposRootWithoutCloning() {
        Path outside = temp.resolve("elsewhere").resolve("1");
        assertThatThrownBy(() -> service.cloneOrFetch(outside, "https://github.com/o/r.git", null, null))
                .isInstanceOf(GitCloneException.class);
        assertThat(outside).doesNotExist();

        Path escaping = reposRoot.resolve("1/../../../evil");
        assertThatThrownBy(() -> service.cloneOrFetch(escaping, "https://github.com/o/r.git", null, null))
                .isInstanceOf(GitCloneException.class);
        assertThat(temp.resolve("evil")).doesNotExist();

        assertThatThrownBy(() -> service.cloneOrFetch(reposRoot, "https://github.com/o/r.git", null, null))
                .isInstanceOf(GitCloneException.class);
    }

    @Test
    void credentialsProviderCarriesXAccessTokenAndDecryptedToken() throws Exception {
        UsernamePasswordCredentialsProvider provider = GitCloneService.credentialsFor("ghp_decrypted-token");
        CredentialItem.Username username = new CredentialItem.Username();
        CredentialItem.Password password = new CredentialItem.Password();

        assertThat(provider.get(new URIish("https://github.com/octocat/demo.git"), username, password))
                .isTrue();
        assertThat(username.getValue()).isEqualTo("x-access-token");
        assertThat(new String(password.getValue())).isEqualTo("ghp_decrypted-token");
    }

    @Test
    void deleteCloneRemovesDirectoryButRefusesPathsOutsideRoot() throws Exception {
        Path origin = temp.resolve("origin");
        GitRepoFixtures.createBareRepoWithCommit(origin, "octocat", "gone");
        Path target = reposRoot.resolve("7");
        service.cloneOrFetch(target, origin.resolve("octocat/gone.git").toUri().toString(), null, null);
        assertThat(target).isDirectory();

        service.deleteClone(target);
        assertThat(target).doesNotExist();

        Path outside = temp.resolve("keep-me");
        Files.createDirectories(outside);
        assertThatThrownBy(() -> service.deleteClone(outside)).isInstanceOf(GitCloneException.class);
        assertThat(outside).exists();
    }
}
