package dev.codeintelligence.history;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.evidence.EvidenceService;
import dev.codeintelligence.evidence.EvidenceSubjects;
import dev.codeintelligence.evidence.NewEvidence;
import dev.codeintelligence.github.GithubPullRequestsPermissionException;
import dev.codeintelligence.github.GithubTokenProvider;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectRepository;
import dev.codeintelligence.testsupport.TestJobContext;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.web.client.RestClientException;

class GitMetadataPermissionTest {
    private final GitMetadataScanner scanner = mock(GitMetadataScanner.class);
    private final GitMetadataStore store = mock(GitMetadataStore.class);
    private final PullRequestCollector pulls = mock(PullRequestCollector.class);
    private final ProjectRepository projects = mock(ProjectRepository.class);
    private final GithubTokenProvider tokens = mock(GithubTokenProvider.class);
    private final EvidenceService evidence = mock(EvidenceService.class);
    private final Project project = mock(Project.class);
    private final TestJobContext context = new TestJobContext(1, 2, 3L, Path.of("/synthetic/not-read"));
    private final GitMetadataStep step = new GitMetadataStep(
            scanner,
            store,
            pulls,
            projects,
            tokens,
            new AnalysisProperties(20000, 1048576, 10000, 0, 1000, 0.5),
            evidence);

    private void fixture() throws Exception {
        when(projects.findById(2L)).thenReturn(Optional.of(project));
        when(project.getId()).thenReturn(2L);
        when(project.getUserId()).thenReturn(4L);
        when(project.getSourceType()).thenReturn("GITHUB");
        when(project.getRepoOwner()).thenReturn("synthetic");
        when(project.getRepoName()).thenReturn("fixture");
        when(tokens.findToken(4L)).thenReturn(Optional.of("synthetic-token"));
        when(store.findPullsEtag(2L)).thenReturn(Optional.of("preserved-etag"));
        when(scanner.scan(context.clonePath(), 10000))
                .thenReturn(new GitMetadataScan(List.of(), List.of(), List.of(), 7));
    }

    @Test
    void optionalPrPermissionPreservesRowsEtagAndCombinesWarningsWhileCompletingStep() throws Exception {
        fixture();
        when(pulls.fetchAll(anyString(), anyString(), anyString(), anyString()))
                .thenThrow(new GithubPullRequestsPermissionException());
        step.run(context);
        assertThat(context.progress()).isEqualTo(100);
        verify(store).replaceCloneMetadata(eq(2L), any());
        verify(store, never()).upsertPulls(anyLong(), anyList());
        verify(store, never()).savePullsEtag(anyLong(), any());
        ArgumentCaptor<List<NewEvidence>> captured = ArgumentCaptor.forClass(List.class);
        verify(evidence).replaceLinked(eq(2L), eq(EvidenceSubjects.GIT_METADATA), eq(3L), captured.capture());
        assertThat(captured.getValue()).hasSize(2);
        assertThat(captured.getValue())
                .extracting(NewEvidence::excerpt)
                .anyMatch(text -> text.contains("omitted 7"))
                .anyMatch(text -> text.contains("PR_METADATA_PERMISSION_DENIED"));
    }

    @Test
    void unrelatedFailureStillFailsTheStep() throws Exception {
        fixture();
        when(pulls.fetchAll(anyString(), anyString(), anyString(), anyString()))
                .thenThrow(new RestClientException("synthetic generic failure"));
        assertThatThrownBy(() -> step.run(context)).isInstanceOf(RestClientException.class);
        assertThat(context.progress()).isEqualTo(70);
        verifyNoInteractions(evidence);
    }

    @Test
    void localProjectNeverReadsCredentialsOrFetchesGithubMetadata() throws Exception {
        fixture();
        when(project.getSourceType()).thenReturn("LOCAL");
        step.run(context);
        assertThat(context.progress()).isEqualTo(100);
        verifyNoInteractions(tokens, pulls);
        verify(store, never()).findPullsEtag(anyLong());
    }
}
