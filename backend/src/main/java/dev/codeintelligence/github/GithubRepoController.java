package dev.codeintelligence.github;

import com.fasterxml.jackson.annotation.JsonProperty;
import dev.codeintelligence.common.security.AuthenticatedUser;
import java.util.List;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/github")
public class GithubRepoController {

    private final GithubRepoService githubRepoService;

    public GithubRepoController(GithubRepoService githubRepoService) {
        this.githubRepoService = githubRepoService;
    }

    @GetMapping("/repos")
    public RepoListResponse repos(
            @AuthenticationPrincipal AuthenticatedUser user,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "30") int perPage,
            @RequestParam(required = false) String q) {
        GithubRepoPage repoPage = githubRepoService.listRepos(user.userId(), page, perPage, q);
        return repoResponse(repoPage, page);
    }

    private RepoListResponse repoResponse(GithubRepoPage repoPage, int page) {
        List<RepoItem> items = repoPage.items().stream()
                .map(repo -> new RepoItem(
                        repo.owner(),
                        repo.name(),
                        repo.fullName(),
                        repo.isPrivate(),
                        repo.defaultBranch(),
                        repo.description(),
                        repo.updatedAt()))
                .toList();
        return new RepoListResponse(items, page, repoPage.hasNext());
    }

    @GetMapping("/installations")
    public InstallationListResponse installations(
            @AuthenticationPrincipal AuthenticatedUser user,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "30") int perPage) {
        int boundedPage = Math.max(1, page);
        GithubApiClient.InstallationPage result =
                githubRepoService.listInstallations(user.userId(), boundedPage, Math.clamp(perPage, 1, 100));
        return new InstallationListResponse(result.items(), boundedPage, result.hasNext());
    }

    @GetMapping("/installations/{installationId}/repos")
    public RepoListResponse installationRepos(
            @AuthenticationPrincipal AuthenticatedUser user,
            @PathVariable long installationId,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "30") int perPage,
            @RequestParam(required = false) String q) {
        int boundedPage = Math.max(1, page);
        return repoResponse(
                githubRepoService.listInstallationRepos(
                        user.userId(), installationId, boundedPage, Math.clamp(perPage, 1, 100), q),
                boundedPage);
    }

    public record InstallationListResponse(
            List<GithubApiClient.InstallationSummary> items, int page, boolean hasNext) {}

    @GetMapping("/repos/{owner}/{repo}/branches")
    public BranchListResponse branches(
            @AuthenticationPrincipal AuthenticatedUser user,
            @PathVariable String owner,
            @PathVariable String repo,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "100") int perPage) {
        GithubBranchPage branchPage = githubRepoService.listBranches(
                user.userId(), owner, repo, Math.max(1, page), Math.clamp(perPage, 1, 100));
        List<BranchItem> items = branchPage.items().stream()
                .map(branch -> new BranchItem(branch.name(), branch.commitSha(), branch.isProtected()))
                .toList();
        return new BranchListResponse(items, page, branchPage.hasNext());
    }

    public record RepoItem(
            String owner,
            String name,
            String fullName,
            @JsonProperty("private") boolean isPrivate,
            String defaultBranch,
            String description,
            String updatedAt) {}

    public record RepoListResponse(List<RepoItem> items, int page, boolean hasNext) {}

    public record BranchItem(
            String name,
            String commitSha,
            @JsonProperty("protected") boolean isProtected) {}

    public record BranchListResponse(List<BranchItem> items, int page, boolean hasNext) {}
}
