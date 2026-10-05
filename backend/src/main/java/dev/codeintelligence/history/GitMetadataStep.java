package dev.codeintelligence.history;

import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.evidence.EvidenceKind;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.evidence.EvidenceSubjects;
import dev.codeintelligence.evidence.NewEvidence;
import dev.codeintelligence.github.GithubPullRequestsPermissionException;
import dev.codeintelligence.github.GithubTokenProvider;
import dev.codeintelligence.github.InvalidGithubTokenException;
import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobStep;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectRepository;
import java.util.ArrayList;
import java.util.List;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

@Component
@Order(GitMetadataStep.ORDER)
public class GitMetadataStep implements JobStep {

    public static final String KEY = "GIT_METADATA";
    public static final int ORDER = 500;

    private final GitMetadataScanner scanner;
    private final GitMetadataStore store;
    private final PullRequestCollector pullRequestCollector;
    private final ProjectRepository projectRepository;
    private final GithubTokenProvider tokenProvider;
    private final AnalysisProperties analysisProperties;
    private final EvidenceService evidenceService;

    public GitMetadataStep(
            GitMetadataScanner scanner,
            GitMetadataStore store,
            PullRequestCollector pullRequestCollector,
            ProjectRepository projectRepository,
            GithubTokenProvider tokenProvider,
            AnalysisProperties analysisProperties,
            EvidenceService evidenceService) {
        this.scanner = scanner;
        this.store = store;
        this.pullRequestCollector = pullRequestCollector;
        this.projectRepository = projectRepository;
        this.tokenProvider = tokenProvider;
        this.analysisProperties = analysisProperties;
        this.evidenceService = evidenceService;
    }

    @Override
    public String key() {
        return KEY;
    }

    @Override
    public void run(JobContext ctx) throws Exception {
        long snapshotId =
                ctx.snapshotId().orElseThrow(() -> new IllegalStateException("no snapshot attached to the job"));
        Project project = projectRepository
                .findById(ctx.projectId())
                .orElseThrow(() -> new IllegalStateException("project no longer exists"));
        ctx.updateProgress(10);
        GitMetadataScan scan = scanner.scan(ctx.clonePath(), analysisProperties.maxCommits());
        ctx.updateProgress(40);
        store.replaceCloneMetadata(ctx.projectId(), scan);
        ctx.updateProgress(70);
        boolean pullsUnavailable = false;
        try {
            collectPulls(project);
        } catch (GithubPullRequestsPermissionException missingPermission) {
            pullsUnavailable = true;
        }
        recordWarnings(ctx.projectId(), snapshotId, scan.omittedCommitCount(), pullsUnavailable);
        ctx.updateProgress(100);
    }

    private void recordWarnings(long projectId, long snapshotId, int omitted, boolean pullsUnavailable) {
        List<NewEvidence> warnings = new ArrayList<>();
        if (omitted > 0)
            warnings.add(new NewEvidence(
                    EvidenceKind.CONFIG,
                    null,
                    null,
                    null,
                    "Truncated to app.analysis.max-commits; omitted " + omitted + " older commits."));
        if (pullsUnavailable)
            warnings.add(
                    new NewEvidence(
                            EvidenceKind.CONFIG,
                            null,
                            null,
                            null,
                            "PR_METADATA_PERMISSION_DENIED: Pull request metadata was not collected because GitHub did not grant "
                                    + "pull-request access. Source and clone history analysis continue; any previously saved PR metadata is unchanged and was not refreshed."));
        if (warnings.isEmpty()) evidenceService.deleteLinked(EvidenceSubjects.GIT_METADATA, snapshotId);
        else evidenceService.replaceLinked(projectId, EvidenceSubjects.GIT_METADATA, snapshotId, List.copyOf(warnings));
    }

    private void collectPulls(Project project) {
        if (!"GITHUB".equals(project.getSourceType())) return;
        var token = tokenProvider.findCredential(project.getUserId()).orElse(null);
        if (token == null) {
            return;
        }
        String etag = store.findPullsEtag(project.getId()).orElse(null);
        try {
            PullRequestCollector.PullsFetch fetch = pullRequestCollector.fetchAll(
                    token.value(), project.getRepoOwner(), project.getRepoName(), etag, token::verify);
            token.publish(() -> {
                if (!fetch.notModified()) {
                    store.upsertPulls(project.getId(), fetch.pulls());
                    store.savePullsEtag(project.getId(), fetch.etag());
                }
            });
        } catch (InvalidGithubTokenException rejected) {
            token.reject();
            throw rejected;
        }
    }
}
