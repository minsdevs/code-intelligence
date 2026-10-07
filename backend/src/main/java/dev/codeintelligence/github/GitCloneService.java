package dev.codeintelligence.github;

import dev.codeintelligence.common.AppProperties;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.eclipse.jgit.api.CloneCommand;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.api.ResetCommand;
import org.eclipse.jgit.api.errors.GitAPIException;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.Repository;
import org.eclipse.jgit.transport.CredentialsProvider;
import org.eclipse.jgit.transport.UsernamePasswordCredentialsProvider;
import org.springframework.stereotype.Service;
import org.springframework.util.FileSystemUtils;

/**
 * JGit clone/fetch into {@code ${app.data-dir}/repos/{projectId}} (§1-2). The cloned tree is only
 * ever read — never built or executed (§18). Tokens arrive already decrypted, are wrapped in a
 * per-call CredentialsProvider ({@code x-access-token} username), and are never logged.
 */
@Service
public class GitCloneService {

    public record CloneResult(String headSha, String branch) {}

    private final AppProperties appProperties;

    public GitCloneService(AppProperties appProperties) {
        this.appProperties = appProperties;
    }

    /** Clones on first run; reuses the existing clone with a fetch + hard reset afterwards. */
    public CloneResult cloneOrFetch(Path targetDir, String remoteUri, String token, String preferredBranch) {
        Path target = requireUnderReposRoot(targetDir);
        CredentialsProvider credentials = token == null ? null : credentialsFor(token);
        String branch = requireValidBranch(preferredBranch);
        try {
            if (Files.isDirectory(target.resolve(Constants.DOT_GIT))) {
                return fetchExisting(target, credentials, branch);
            }
            Files.createDirectories(target.getParent());
            CloneCommand command = Git.cloneRepository()
                    .setURI(remoteUri)
                    .setDirectory(target.toFile())
                    .setCredentialsProvider(credentials)
                    .setNoCheckout(true);
            if (branch != null) {
                command.setBranch(Constants.R_HEADS + branch);
            }
            try (Git git = command.call()) {
                disableFilterDrivers(git.getRepository());
                git.reset()
                        .setMode(ResetCommand.ResetType.HARD)
                        .setRef(Constants.HEAD)
                        .call();
                return headOf(git);
            }
        } catch (GitAPIException | IOException e) {
            throw new GitCloneException("git clone/fetch failed: " + e.getMessage(), e);
        }
    }

    /** Removes a project clone; the canonical-path check runs again right before deletion. */
    public void deleteClone(Path targetDir) {
        Path target = requireUnderReposRoot(targetDir);
        try {
            FileSystemUtils.deleteRecursively(target);
        } catch (IOException e) {
            throw new GitCloneException("failed to delete clone directory", e);
        }
    }

    static UsernamePasswordCredentialsProvider credentialsFor(String token) {
        return new UsernamePasswordCredentialsProvider("x-access-token", token);
    }

    private CloneResult fetchExisting(Path target, CredentialsProvider credentials, String preferredBranch)
            throws GitAPIException, IOException {
        try (Git git = Git.open(target.toFile())) {
            disableFilterDrivers(git.getRepository());
            git.fetch()
                    .setCredentialsProvider(credentials)
                    .setRemoveDeletedRefs(true)
                    .call();
            String branch = preferredBranch != null
                    ? preferredBranch
                    : git.getRepository().getBranch();
            ObjectId remoteHead =
                    git.getRepository().resolve(Constants.R_REMOTES + Constants.DEFAULT_REMOTE_NAME + "/" + branch);
            if (remoteHead == null) {
                throw new GitCloneException("requested branch is unavailable: " + branch, null);
            }
            git.reset()
                    .setMode(ResetCommand.ResetType.HARD)
                    .setRef(remoteHead.name())
                    .call();
            ObjectId head = git.getRepository().resolve(Constants.HEAD);
            return new CloneResult(head.name(), branch);
        }
    }

    /**
     * Hostile {@code .gitattributes} can select filter drivers that the user's own Git configuration
     * defines (for example {@code git lfs install}), and JGit runs their smudge command on checkout.
     * {@code $GIT_DIR/info/attributes} has the highest attribute precedence, so unsetting
     * {@code filter} there keeps checkout and reset free of external commands; LFS pointers stay text.
     */
    static void disableFilterDrivers(Repository repository) throws IOException {
        Path attributes = repository.getDirectory().toPath().resolve(Constants.INFO_ATTRIBUTES);
        Files.createDirectories(attributes.getParent());
        Files.writeString(attributes, NO_FILTER_ATTRIBUTES, StandardCharsets.UTF_8);
    }

    static final String NO_FILTER_ATTRIBUTES = "* -filter\n";

    private CloneResult headOf(Git git) throws IOException {
        ObjectId head = git.getRepository().resolve(Constants.HEAD);
        if (head == null) {
            throw new GitCloneException("repository has no HEAD commit", null);
        }
        return new CloneResult(head.name(), git.getRepository().getBranch());
    }

    private String requireValidBranch(String preferredBranch) {
        if (preferredBranch == null || preferredBranch.isBlank()) {
            return null;
        }
        String branch = preferredBranch.trim();
        if (!Repository.isValidRefName(Constants.R_HEADS + branch)) {
            throw new GitCloneException("invalid branch name", null);
        }
        return branch;
    }

    /**
     * The canonical target must stay strictly below {@code ${app.data-dir}/repos}; symlinked
     * directories are resolved before comparison when they exist.
     */
    private Path requireUnderReposRoot(Path targetDir) {
        Path root = appProperties.reposRoot();
        Path resolved = targetDir.toAbsolutePath().normalize();
        if (!resolved.startsWith(root) || resolved.equals(root)) {
            throw new GitCloneException("clone path escapes the repository storage root", null);
        }
        try {
            if (Files.exists(resolved) && Files.exists(root)) {
                Path realTarget = resolved.toRealPath();
                Path realRoot = root.toRealPath();
                if (!realTarget.startsWith(realRoot) || realTarget.equals(realRoot)) {
                    throw new GitCloneException("clone path escapes the repository storage root", null);
                }
                return realTarget;
            }
        } catch (IOException e) {
            throw new GitCloneException("failed to resolve clone path", e);
        }
        return resolved;
    }
}
