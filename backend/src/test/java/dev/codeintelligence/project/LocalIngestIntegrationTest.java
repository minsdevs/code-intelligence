package dev.codeintelligence.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.core.FileInventoryStep;
import dev.codeintelligence.analysis.coverage.CoverageController;
import dev.codeintelligence.common.security.AuthenticatedUser;
import dev.codeintelligence.common.security.CredentialKind;
import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobWorker;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import tools.jackson.databind.json.JsonMapper;

/** Real local import/inventory steps, database records and controller response projections. */
@SpringBootTest(
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            "app.ts-analyzer.base-url=",
            "app.tree-analyzer.base-url=",
            "app.ai.provider=none",
            "app.ai.openai.api-key=",
            "app.ai.gemini.api-key=",
            "app.github.base-url=http://127.0.0.1:1"
        })
@Import(TestcontainersConfiguration.class)
class LocalIngestIntegrationTest {
    @TempDir
    static Path root;

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    ImportStep importStep;

    @Autowired
    FileInventoryStep inventoryStep;

    @Autowired
    ProjectController projects;

    @Autowired
    CoverageController coverage;

    @Autowired
    LocalImportDiagnostics diagnostics;

    @Autowired
    LocalSourceApprovalService approvals;

    @Autowired
    ProjectService projectService;

    @MockitoBean
    JobWorker worker;

    @Autowired
    JsonMapper json;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> root.resolve("data").toString());
        registry.add("app.local-import.allowed-roots", () -> root.toString());
    }

    @ParameterizedTest
    @ValueSource(strings = {"file", "directory", "head"})
    void knownCredentialMetadataNeverReachesPersistedPathsOrApiResponses(String kind) throws Exception {
        Fixture f = fixture();
        String sentinel = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        Path extra =
                switch (kind) {
                    case "file" -> f.source().resolve(sentinel + ".java");
                    case "directory" -> f.source().resolve(sentinel + "/Extra.java");
                    default -> f.source().resolve(".git/HEAD");
                };
        Files.createDirectories(extra.getParent());
        String metadata = kind.equals("head") ? "ref: refs/heads/" + sentinel + "\n" : "class Extra {}\n";
        Files.writeString(extra, metadata);
        Map<String, byte[]> before = sourceBytes(f.source());

        approve(f);
        importStep.run(f.ctx());
        long snapshot = f.ctx().snapshotId().orElseThrow();
        inventoryStep.run(f.ctx());
        jdbc.update("update snapshots set status = 'READY' where id = ?", snapshot);
        jdbc.update("update projects set current_snapshot_id = ? where id = ?", snapshot, f.project());

        assertThat(jdbc.queryForObject("select default_branch from projects where id = ?", String.class, f.project()))
                .isEqualTo("known-safe");
        assertThat(jdbc.queryForList("select path from files where snapshot_id = ?", String.class, snapshot))
                .containsExactly("Main.java");
        String excerpt = summary(f.project(), snapshot);
        assertThat(excerpt).doesNotContain(sentinel, f.source().toString(), "Main.java");
        assertThat(excerpt.getBytes(StandardCharsets.UTF_8))
                .hasSizeLessThanOrEqualTo(LocalImportDiagnostics.MAX_JSON_BYTES);
        var stored = json.readValue(excerpt, LocalImportService.ImportSummary.class);
        assertThat(stored.acceptedFiles()).isEqualTo(1);
        assertThat(stored.excludedEntriesByReason())
                .containsEntry(kind.equals("head") ? "GENERATED_DIRECTORY" : "SECRET_PATH", 1);
        var response = coverage.getCoverage(f.project(), f.user());
        assertThat(response.localImport()).isNotNull();
        assertThat(response.localImport().acceptedFiles()).isEqualTo(1);
        assertThat(response.fileCoverage().inventoriedFiles()).isEqualTo(1);
        assertThat(json.writeValueAsString(response)).doesNotContain(sentinel);
        assertThat(json.writeValueAsString(projects.get(f.project(), f.user()))).doesNotContain(sentinel);
        assertSourceUnchanged(before, f.source());
        assertThat(Files.readString(extra)).isEqualTo(metadata);

        // The dedicated subject survives inventory warning replacement, and retry replaces one record.
        diagnostics.record(f.project(), snapshot, stored);
        inventoryStep.run(f.ctx());
        assertThat(summary(f.project(), snapshot)).isEqualTo(excerpt);
        assertThat(jdbc.queryForObject("""
                select count(*) from evidences e join evidence_links l on l.evidence_id = e.id
                where e.project_id = ? and l.subject_type = 'LOCAL_IMPORT' and l.subject_id = ?
                """, Integer.class, f.project(), snapshot))
                .isEqualTo(1);
    }

    @Test
    void failedStagingPreservesTheCurrentSnapshotRepositoryAndDiagnostic() throws Exception {
        Fixture f = fixture();
        approve(f);
        importStep.run(f.ctx());
        long snapshot = f.ctx().snapshotId().orElseThrow();
        inventoryStep.run(f.ctx());
        jdbc.update("update projects set current_snapshot_id = ? where id = ?", snapshot, f.project());
        String excerpt = summary(f.project(), snapshot);
        jdbc.update(
                "update analysis_jobs set status = 'DONE' where id = ?", f.ctx().jobId());
        approve(f);
        Files.writeString(f.source().resolve(".gitignore"), "[unsupported-class]\n");
        Files.writeString(f.source().resolve("Main.java"), "class Changed {}\n");

        assertThatThrownBy(() -> importStep.run(f.ctx())).isInstanceOf(LocalSourceApprovalException.class);

        assertThat(jdbc.queryForObject(
                        "select current_snapshot_id from projects where id = ?", Long.class, f.project()))
                .isEqualTo(snapshot);
        assertThat(jdbc.queryForObject(
                        "select count(*) from snapshots where project_id = ?", Integer.class, f.project()))
                .isEqualTo(1);
        assertThat(summary(f.project(), snapshot)).isEqualTo(excerpt);
        assertThat(Files.readString(f.ctx().clonePath().resolve("Main.java"))).isEqualTo("class Main {}\n");
    }

    private String summary(long project, long snapshot) {
        return jdbc.queryForObject("""
                select e.excerpt from evidences e join evidence_links l on l.evidence_id = e.id
                where e.project_id = ? and e.kind = 'CONFIG' and l.subject_type = 'LOCAL_IMPORT'
                  and l.subject_id = ? and e.file_path is null and e.line_start is null and e.line_end is null
                """, String.class, project, snapshot);
    }

    private void approve(Fixture fixture) {
        LocalSourcePreview preview =
                approvals.previewRefresh(fixture.project(), fixture.user().userId());
        long job = projectService.reanalyze(fixture.project(), fixture.user().userId(), preview.previewToken());
        jdbc.update("update analysis_jobs set status = 'RUNNING' where id = ?", job);
        when(fixture.ctx().jobId()).thenReturn(job);
    }

    private Fixture fixture() throws Exception {
        String unique = UUID.randomUUID().toString();
        Path source = Files.createDirectories(root.resolve("source-" + unique));
        Files.writeString(source.resolve("Main.java"), "class Main {}\n");
        long user = jdbc.queryForObject("""
                insert into users (login, identity_type, local_key) values ('ingest-fixture', 'LOCAL', ?) returning id
                """, Long.class, unique);
        long project = jdbc.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name, source_type, local_path, default_branch)
                values (?, 'Ingest fixture', 'local', ?, 'LOCAL', ?, 'known-safe') returning id
                """, Long.class, user, unique, source.toString());
        JobContext ctx = mock(JobContext.class);
        when(ctx.projectId()).thenReturn(project);
        when(ctx.clonePath()).thenReturn(root.resolve("data/repos/" + project));
        when(ctx.snapshotId())
                .thenAnswer(invocation -> Optional.ofNullable(jdbc.queryForObject(
                        "select snapshot_id from analysis_jobs where id = ?", Long.class, ctx.jobId())));
        doAnswer(invocation -> {
                    jdbc.update(
                            "update analysis_jobs set snapshot_id = ? where id = ?",
                            invocation.<Long>getArgument(0),
                            ctx.jobId());
                    return null;
                })
                .when(ctx)
                .attachSnapshot(org.mockito.ArgumentMatchers.anyLong());
        return new Fixture(
                project,
                source,
                ctx,
                new AuthenticatedUser(user, null, "ingest-fixture", null, null, CredentialKind.LOCAL));
    }

    private Map<String, byte[]> sourceBytes(Path source) throws Exception {
        Map<String, byte[]> bytes = new LinkedHashMap<>();
        try (var paths = Files.walk(source)) {
            for (Path path : paths.filter(Files::isRegularFile).toList())
                bytes.put(source.relativize(path).toString(), Files.readAllBytes(path));
        }
        return bytes;
    }

    private void assertSourceUnchanged(Map<String, byte[]> before, Path source) throws Exception {
        Map<String, byte[]> after = sourceBytes(source);
        assertThat(after.keySet()).isEqualTo(before.keySet());
        for (String path : before.keySet()) assertThat(after.get(path)).isEqualTo(before.get(path));
    }

    private record Fixture(long project, Path source, JobContext ctx, AuthenticatedUser user) {}
}
