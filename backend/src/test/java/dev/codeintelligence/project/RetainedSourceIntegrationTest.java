package dev.codeintelligence.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doCallRealMethod;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.ai.ContextRetrievalService;
import dev.codeintelligence.analysis.core.FileInventoryStep;
import dev.codeintelligence.analysis.core.FileService;
import dev.codeintelligence.analysis.core.SnapshotSourceException;
import dev.codeintelligence.common.AppProperties;
import dev.codeintelligence.common.DesktopPrivateBootstrap;
import dev.codeintelligence.job.FinalizeStep;
import dev.codeintelligence.job.JobConflictException;
import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobProgressPublisher;
import dev.codeintelligence.job.JobRepository;
import dev.codeintelligence.job.JobService;
import dev.codeintelligence.job.JobStatus;
import dev.codeintelligence.job.JobStep;
import dev.codeintelligence.job.JobType;
import dev.codeintelligence.job.JobWorker;
import dev.codeintelligence.job.JobWorkspaceProvider;
import dev.codeintelligence.job.Pipeline;
import dev.codeintelligence.job.StepStatus;
import dev.codeintelligence.source.SourceStoreClient;
import dev.codeintelligence.source.SourceStoreException;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.revwalk.RevWalk;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.convention.TestBean;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.ErrorResponseException;
import tools.jackson.databind.json.JsonMapper;

/**
 * Real PostgreSQL, Java Unix-socket client and Node vault/broker with a public synthetic wrapper.
 * Native confinement is not established. Direct-step fixtures still exercise the legacy managed
 * clone path; real-worker fixtures separately verify disposable retained workspaces. This is not
 * complete T02 encryption-at-rest acceptance. Direct-lease tests are distinct from the explicit
 * JobService.retry integration cases below.
 */
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
class RetainedSourceIntegrationTest {
    private static final String FILE = "src/main/java/demo/Sample.java";
    private static final String A = "package demo; class Sample { String value = \"SOURCE_A\"; }\n";
    private static final String B = "package demo; class Sample { String value = \"SOURCE_B\"; }\n";
    private static NodeBridge bridge;

    @TestBean(methodName = "privateBootstrap")
    DesktopPrivateBootstrap privateBootstrap;

    static DesktopPrivateBootstrap privateBootstrap() {
        var json = new JsonMapper();
        byte[] bytes = json.writeValueAsBytes(Map.of(
                "version",
                2,
                "ai",
                Map.of("socketPath", "/tmp/retained-ai.sock", "capability", "e".repeat(64), "epoch", "f".repeat(64)),
                "source",
                Map.of("socketPath", bridge.socket.toString(), "capability", NodeBridge.TOKEN)));
        return new DesktopPrivateBootstrap(new ByteArrayInputStream(bytes), json, Duration.ofSeconds(3));
    }

    @TempDir
    static Path root;

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    TransactionTemplate transactions;

    @Autowired
    LocalSourceApprovalService approvals;

    @Autowired
    ProjectService projects;

    @Autowired
    LocalSnapshotStore retained;

    @MockitoSpyBean
    SourceStoreClient sourceClient;

    @Autowired
    FileService files;

    @Autowired
    ContextRetrievalService retrieval;

    @Autowired
    ImportStep importStep;

    @Autowired
    FileInventoryStep inventoryStep;

    @Autowired
    FinalizeStep finalizeStep;

    @Autowired
    JobWorkspaceProvider workspaces;

    @Autowired
    JobRepository jobs;

    @Autowired
    JobService jobService;

    @MockitoSpyBean
    LocalImportDiagnostics diagnostics;

    @Autowired
    AppProperties app;

    @MockitoBean
    JobWorker worker;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        try {
            if (bridge == null) bridge = new NodeBridge();
            bridge.start();
        } catch (Exception error) {
            throw new IllegalStateException("Disposable source bridge failed to start", error);
        }
        registry.add("app.data-dir", () -> root.resolve("data").toString());
        registry.add("app.local-import.allowed-roots", () -> root.toString());
    }

    @AfterAll
    static void closeBridge() throws Exception {
        if (bridge != null) bridge.close();
    }

    @Test
    void renamedUnchangedFilesReuseDurableBytesWithoutRestaging() throws Exception {
        Fixture f = fixture(A);
        long previous = analyze(f.initial());
        String renamed = "src/main/java/demo/Renamed.java";
        Files.move(f.source().resolve(FILE), f.source().resolve(renamed));
        clearInvocations(sourceClient);
        long next = analyze(refresh(f));
        assertThat(files.fileContent(f.project(), f.user(), renamed, next).content())
                .isEqualTo(A);
        assertThat(files.fileContent(f.project(), f.user(), FILE, previous).content())
                .isEqualTo(A);
        assertThat(jdbc.queryForList("select path from files where snapshot_id=?", String.class, next))
                .containsExactly(renamed);
        assertThat(count("source_blobs", f.project())).isEqualTo(1);
        verify(sourceClient, org.mockito.Mockito.never()).stage(anyLong(), any());
        verify(sourceClient).retain(eq(f.project()), any());
    }

    @Test
    void sameSizeChangesStageNewBytesWhileUnchangedFilesRemainReusable() throws Exception {
        Fixture f = fixture(A);
        analyze(f.initial());
        String unchanged = "retained.txt";
        Files.writeString(f.source().resolve(unchanged), A);
        Files.writeString(f.source().resolve(FILE), B);
        clearInvocations(sourceClient);
        long next = analyze(refresh(f));
        assertThat(files.fileContent(f.project(), f.user(), FILE, next).content())
                .isEqualTo(B);
        assertThat(files.fileContent(f.project(), f.user(), unchanged, next).content())
                .isEqualTo(A);
        assertThat(count("source_blobs", f.project())).isEqualTo(2);
        verify(sourceClient).stage(f.project(), B.getBytes(StandardCharsets.UTF_8));
        verify(sourceClient).retain(eq(f.project()), any());
    }

    @Test
    void damagedReusableSourceCannotPublishEvenWhenLiveBytesAreAvailable() throws Exception {
        Fixture f = fixture(A);
        long previous = analyze(f.initial());
        UUID generation = currentGeneration(f.project());
        Files.writeString(f.source().resolve("same.txt"), A);
        Context next = refresh(f);
        Path blob = bridge.blob(f.project(), hash(A));
        byte[] original = Files.readAllBytes(blob);
        byte[] damaged = original.clone();
        damaged[damaged.length - 1] ^= 1;
        Files.write(blob, damaged);
        try {
            assertThatThrownBy(() -> run(next, importStep)).isInstanceOf(SourceStoreException.class);
            assertThat(currentSnapshot(f.project())).isEqualTo(previous);
            assertThat(currentGeneration(f.project())).isEqualTo(generation);
            assertThat(count("snapshots", f.project())).isEqualTo(1);
        } finally {
            Files.write(blob, original);
        }
    }

    @Test
    void refreshRetainsOldBytesAndCommitsAGenerationWithoutChangingUserRecords() throws Exception {
        Fixture f = fixture(A);
        assertThat(sourceClient.enabled()).isTrue();
        assertThat(retained.enabled()).isTrue();
        long a = analyze(f.initial());
        UUID generationA = currentGeneration(f.project());
        String oidA = fileOid(a);
        assertThat(Files.readString(f.source().resolve(FILE))).isEqualTo(A);
        long note = jdbc.queryForObject(
                "insert into notes(project_id,title,content_md) values (?, 'Retained note', 'User text') returning id",
                Long.class,
                f.project());
        long task = jdbc.queryForObject(
                "insert into tasks(project_id,type,title,description) values (?, 'REVIEW', 'Retained task', 'User intent') returning id",
                Long.class,
                f.project());
        long reference = jdbc.queryForObject(
                "insert into note_references(note_id,subject_type,subject_id,raw_target,label) values (?, 'SNAPSHOT', ?, 'original', 'Original source') returning id",
                Long.class,
                note,
                a);
        long goal = jdbc.queryForObject(
                "insert into task_goals(task_id,seq,content) values (?, 1, 'Keep this goal') returning id",
                Long.class,
                task);
        var noteBefore = jdbc.queryForMap("select * from notes where id=?", note);
        var taskBefore = jdbc.queryForMap("select * from tasks where id=?", task);
        var referenceBefore = jdbc.queryForMap("select * from note_references where id=?", reference);
        var goalBefore = jdbc.queryForMap("select * from task_goals where id=?", goal);

        Files.writeString(f.source().resolve(FILE), B);
        Context next = refresh(f);
        long b = analyze(next);
        assertThat(b).isNotEqualTo(a);
        assertThat(Files.readString(f.source().resolve(FILE))).isEqualTo(B);
        try (var git = Git.open(next.clonePath().toFile());
                var reader = git.getRepository().newObjectReader()) {
            assertThat(reader.has(ObjectId.fromString(oidA)))
                    .as("the current mutable Git repository no longer contains source A")
                    .isFalse();
        }
        var oldSource = files.fileContent(f.project(), f.user(), FILE, a);
        var newSource = files.fileContent(f.project(), f.user(), FILE, b);
        assertThat(oldSource.content()).isEqualTo(A);
        assertThat(oldSource.resolvedSnapshotId()).isEqualTo(a);
        assertThat(oldSource.currentSnapshot()).isFalse();
        assertThat(newSource.content()).isEqualTo(B);
        assertThat(newSource.currentSnapshot()).isTrue();
        assertThat(oldSource.sourceState()).isEqualTo("AVAILABLE");
        assertThat(currentSnapshot(f.project())).isEqualTo(b);
        UUID generationB = currentGeneration(f.project());
        assertThat(generationB).isNotEqualTo(generationA);
        assertCommittedGeneration(f.project(), b, next.jobId(), generationB, generationA);
        assertThat(jdbc.queryForMap("select * from notes where id=?", note)).isEqualTo(noteBefore);
        assertThat(jdbc.queryForMap("select * from tasks where id=?", task)).isEqualTo(taskBefore);
        assertThat(jdbc.queryForMap("select * from note_references where id=?", reference))
                .isEqualTo(referenceBefore);
        assertThat(jdbc.queryForMap("select * from task_goals where id=?", goal))
                .isEqualTo(goalBefore);
        assertEncryptedBlob(f.project(), A);
        assertEncryptedBlob(f.project(), B);
    }

    @Test
    void previewRetrievesTheRetainedSnapshotAfterRefreshAndAfterTheCloneIsDeleted() throws Exception {
        Fixture f = fixture(A);
        long a = analyze(f.initial());
        Files.writeString(f.source().resolve(FILE), B);
        Context next = refresh(f);
        long b = analyze(next);
        assertThat(Files.readString(next.clonePath().resolve(FILE))).isEqualTo(B);
        assertNoSummaryOrUsage(f);

        var beforeDeletion = previewSource(f, a);
        assertPreviewSource(beforeDeletion, A);
        assertThat(beforeDeletion.text()).doesNotContain("SOURCE_B");
        assertNoSummaryOrUsage(f);

        // This is a disposable managed clone beneath this class's @TempDir, never the original.
        assertThat(next.clonePath()
                        .toAbsolutePath()
                        .normalize()
                        .startsWith(root.toAbsolutePath().normalize()))
                .isTrue();
        try (var paths = Files.walk(next.clonePath())) {
            for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.delete(path);
        }
        assertThat(next.clonePath()).doesNotExist();
        assertThat(previewSource(f, a)).isEqualTo(beforeDeletion);
        assertPreviewSource(previewSource(f, b), B);
        assertThat(Files.readString(f.source().resolve(FILE))).isEqualTo(B);
        assertNoSummaryOrUsage(f);
    }

    @ParameterizedTest
    @ValueSource(strings = {"corrupt", "missing"})
    void previewOmitsUnavailableRetainedBytesDespiteAvailableOldGitAndNewLiveSource(String failure) throws Exception {
        Fixture f = fixture(A);
        long a = analyze(f.initial());
        String oidA = fileOid(a);
        Files.writeString(f.source().resolve(FILE), B);
        Context next = refresh(f);
        long b = analyze(next);
        // Preserve a valid old Git blob as well as the current B tree. Either a Git or a live
        // fallback would now produce a SOURCE block, and must therefore fail this assertion.
        try (var git = Git.open(next.clonePath().toFile());
                var writer = git.getRepository().newObjectInserter()) {
            assertThat(writer.insert(Constants.OBJ_BLOB, A.getBytes(StandardCharsets.UTF_8))
                            .name())
                    .isEqualTo(oidA);
            writer.flush();
            try (var reader = git.getRepository().newObjectReader()) {
                assertThat(reader.has(ObjectId.fromString(oidA))).isTrue();
                assertThat(reader.has(ObjectId.fromString(fileOid(b)))).isTrue();
            }
        }
        assertThat(Files.readString(next.clonePath().resolve(FILE))).isEqualTo(B);
        assertNoSummaryOrUsage(f);
        assertPreviewSource(previewSource(f, a), A);
        Path blob = bridge.blob(f.project(), hash(A));
        byte[] encrypted = Files.readAllBytes(blob);
        Path moved = bridge.root.resolve("held-preview-" + UUID.randomUUID() + ".bin");
        try {
            if (failure.equals("corrupt")) {
                byte[] corrupt = encrypted.clone();
                corrupt[corrupt.length - 1] ^= 1;
                Files.write(blob, corrupt);
            } else {
                Files.move(blob, moved);
            }

            var unavailable = previewSource(f, a);
            assertThat(unavailable.blocks()).noneMatch(block -> block.type().equals("SOURCE"));
            assertThat(unavailable.fileRefs()).isEmpty();
            assertThat(unavailable.text())
                    .doesNotContain("SOURCE_A", "SOURCE_B", NodeBridge.TOKEN, bridge.root.toString());
            assertPreviewSource(previewSource(f, b), B);
            assertNoSummaryOrUsage(f);
        } finally {
            if (failure.equals("corrupt")) Files.write(blob, encrypted);
            else Files.move(moved, blob);
        }
        assertPreviewSource(previewSource(f, a), A);
        assertThat(Files.readString(f.source().resolve(FILE))).isEqualTo(B);
        assertNoSummaryOrUsage(f);
    }

    @ParameterizedTest
    @ValueSource(strings = {"corrupt", "missing", "broker"})
    void retainedFailuresReturnGoneEvenWhenTheCurrentGitBlobIsAvailable(String failure) throws Exception {
        Fixture f = fixture(A);
        long snapshot = analyze(f.initial());
        String oid = fileOid(snapshot);
        try (var git = Git.open(f.initial().clonePath().toFile());
                var reader = git.getRepository().newObjectReader()) {
            assertThat(reader.has(ObjectId.fromString(oid))).isTrue();
        }
        Path blob = bridge.blob(f.project(), hash(A));
        byte[] encrypted = Files.readAllBytes(blob);
        Path moved = bridge.root.resolve("held-" + UUID.randomUUID() + ".bin");
        try {
            switch (failure) {
                case "corrupt" -> {
                    byte[] corrupt = encrypted.clone();
                    corrupt[corrupt.length - 1] ^= 1;
                    Files.write(blob, corrupt);
                }
                case "missing" -> Files.move(blob, moved);
                case "broker" -> bridge.stop();
                default -> throw new AssertionError(failure);
            }
            gone(() -> files.fileContent(f.project(), f.user(), FILE, snapshot));
            assertThat(Files.readString(f.source().resolve(FILE))).isEqualTo(A);
            assertThat(Files.readString(f.initial().clonePath().resolve(FILE))).isEqualTo(A);
            assertThat(currentSnapshot(f.project())).isEqualTo(snapshot);
        } finally {
            if (failure.equals("corrupt")) Files.write(blob, encrypted);
            if (failure.equals("missing")) Files.move(moved, blob);
            if (failure.equals("broker")) bridge.start();
        }
        assertThat(files.fileContent(f.project(), f.user(), FILE, snapshot).content())
                .isEqualTo(A);
    }

    @ParameterizedTest
    @ValueSource(strings = {"missing", "unsealed"})
    void retainedContractNeverFallsBackToGitWhenItsManifestIsMissingOrUnsealed(String failure) throws Exception {
        Fixture f = fixture(A);
        long snapshot = analyze(f.initial());
        try (var git = Git.open(f.initial().clonePath().toFile());
                var reader = git.getRepository().newObjectReader()) {
            assertThat(reader.has(ObjectId.fromString(fileOid(snapshot)))).isTrue();
        }
        UUID previousManifest = manifest(snapshot);
        // Only this disposable corruption fixture bypasses the standalone-delete guard. The
        // transaction restores the trigger before commit; ordinary SQL deletion is tested below.
        transactions.executeWithoutResult(tx -> {
            jdbc.update("update projects set current_generation_id=null where id=?", f.project());
            jdbc.execute("alter table source_manifests disable trigger source_manifest_immutable");
            assertThat(jdbc.update("delete from source_manifests where id=?", previousManifest))
                    .isEqualTo(1);
            jdbc.execute("alter table source_manifests enable trigger source_manifest_immutable");
        });
        if (failure.equals("unsealed")) {
            jdbc.update(
                    "insert into source_manifests(id,project_id,snapshot_id,job_id,contract_version,producer_version,"
                            + "source_kind,approval_manifest_sha256,limits_sha256,policy_version,file_count,byte_size) "
                            + "values (?,?,?,?,1,'unsealed-fixture','LOCAL',?,?,'fixture-policy',1,?)",
                    UUID.randomUUID(),
                    f.project(),
                    snapshot,
                    f.initial().jobId(),
                    "a".repeat(64),
                    "b".repeat(64),
                    A.getBytes(StandardCharsets.UTF_8).length);
        }
        assertThat(jdbc.queryForObject(
                        "select source_contract_version from snapshots where id=?", Integer.class, snapshot))
                .isEqualTo(1);
        gone(() -> files.fileContent(f.project(), f.user(), FILE, snapshot));
        assertThat(Files.readString(f.initial().clonePath().resolve(FILE))).isEqualTo(A);
        assertThat(currentSnapshot(f.project())).isEqualTo(snapshot);
    }

    @Test
    void brokerReopenRetainsWrappedKeysAndCanReadThePreviousBlob() throws Exception {
        Fixture f = fixture(A);
        long snapshot = analyze(f.initial());
        Path keyring = bridge.root.resolve("safety/source-vault/source-keyring.wrapped");
        byte[] wrapped = Files.readAllBytes(keyring);
        byte[] encrypted = Files.readAllBytes(bridge.blob(f.project(), hash(A)));
        bridge.stop();
        bridge.start();
        assertThat(Files.readAllBytes(keyring)).isEqualTo(wrapped);
        assertThat(Files.readAllBytes(bridge.blob(f.project(), hash(A)))).isEqualTo(encrypted);
        assertThat(files.fileContent(f.project(), f.user(), FILE, snapshot).content())
                .isEqualTo(A);
    }

    @Test
    void ownerAndSnapshotScopeRemainRequiredBeforeRetainedReads() throws Exception {
        Fixture first = fixture(A);
        long a = analyze(first.initial());
        Fixture other = fixture(B);
        long b = analyze(other.initial());
        notFound(() -> files.fileContent(first.project(), other.user(), FILE, a));
        notFound(() -> files.fileContent(first.project(), first.user(), FILE, b));
        notFound(() -> files.fileContent(other.project(), other.user(), FILE, a));
        assertThatThrownBy(() -> sourceClient.read(other.project(), hash(A), A.getBytes(StandardCharsets.UTF_8).length))
                .isInstanceOf(SourceStoreException.class)
                .hasMessage("SOURCE_STORE_UNAVAILABLE");
        assertThat(files.fileContent(first.project(), first.user(), FILE, a).content())
                .isEqualTo(A);
    }

    @Test
    void sealedManifestsAndEntriesRejectSqlRewritesDeletesAndInsertions() throws Exception {
        Fixture f = fixture(A);
        long snapshot = analyze(f.initial());
        UUID manifest = manifest(snapshot);
        var entry = jdbc.queryForMap("select * from source_manifest_entries where manifest_id=?", manifest);
        var blob = jdbc.queryForMap("select * from source_blobs where project_id=? and sha256=?", f.project(), hash(A));
        byte[] encrypted = Files.readAllBytes(bridge.blob(f.project(), hash(A)));
        for (ThrowingCallable mutation : List.<ThrowingCallable>of(
                () -> jdbc.update(
                        "update source_manifest_entries set git_oid=? where manifest_id=?", "f".repeat(40), manifest),
                () -> jdbc.update("delete from source_manifest_entries where manifest_id=?", manifest),
                () -> jdbc.update(
                        "insert into source_manifest_entries(manifest_id,project_id,path,blob_sha256,git_oid,byte_size) "
                                + "select manifest_id,project_id,'injected.java',blob_sha256,git_oid,byte_size "
                                + "from source_manifest_entries where manifest_id=?",
                        manifest),
                () -> jdbc.update(
                        "update source_manifests set approval_manifest_sha256=? where id=?", "f".repeat(64), manifest),
                () -> jdbc.update("update source_manifests set sealed_at=null where id=?", manifest),
                () -> jdbc.update("delete from source_manifests where id=?", manifest),
                () -> jdbc.update("update source_blobs set key_id=? where project_id=?", "f".repeat(32), f.project()),
                () -> jdbc.update("update source_blobs set byte_size=byte_size where project_id=?", f.project()),
                () -> transactions.executeWithoutResult(tx -> {
                    // The deferred entry FK permits a same-key replacement unless the blob's
                    // DELETE guard prevents rewriting identity within one transaction.
                    jdbc.update("delete from source_blobs where project_id=? and sha256=?", f.project(), hash(A));
                    jdbc.update(
                            "insert into source_blobs(project_id,sha256,byte_size,key_id) values (?,?,?,?)",
                            f.project(),
                            hash(A),
                            ((Number) blob.get("byte_size")).longValue() + 1,
                            "f".repeat(32).equals(blob.get("key_id")) ? "e".repeat(32) : "f".repeat(32));
                }),
                () -> jdbc.update("update snapshots set source_contract_version=0 where id=?", snapshot))) {
            assertThatThrownBy(mutation).isInstanceOf(DataIntegrityViolationException.class);
        }
        assertThat(jdbc.queryForMap("select * from source_manifest_entries where manifest_id=?", manifest))
                .isEqualTo(entry);
        assertThat(jdbc.queryForMap("select * from source_blobs where project_id=? and sha256=?", f.project(), hash(A)))
                .isEqualTo(blob);
        assertThat(Files.readAllBytes(bridge.blob(f.project(), hash(A)))).isEqualTo(encrypted);
        assertThat(files.fileContent(f.project(), f.user(), FILE, snapshot).content())
                .isEqualTo(A);
    }

    @Test
    void deletingTheProjectCascadesRetainedMetadataAndPreservesTheOriginalFolder() throws Exception {
        Fixture f = fixture(A);
        long snapshot = analyze(f.initial());
        UUID manifest = manifest(snapshot);
        assertThat(count("analysis_generations", f.project())).isEqualTo(1);

        projects.delete(f.project(), f.user());

        for (String table : List.of("snapshots", "source_blobs", "source_manifests", "analysis_generations")) {
            assertThat(count(table, f.project()))
                    .as(table + " rows after project deletion")
                    .isZero();
        }
        assertThat(jdbc.queryForObject(
                        "select count(*) from source_manifest_entries where manifest_id=?", Integer.class, manifest))
                .isZero();
        assertThat(jobs.findJob(f.initial().jobId())).isEmpty();
        assertThat(Files.readString(f.source().resolve(FILE))).isEqualTo(A);
        assertThat(f.initial().clonePath()).doesNotExist();
        // Physical ciphertext GC is a separate, currently unimplemented lifecycle. It must not
        // turn a successful metadata cascade into an assertion of complete disk reclamation.
        assertThat(bridge.blob(f.project(), hash(A))).isRegularFile();
        notFound(() -> files.fileContent(f.project(), f.user(), FILE, snapshot));
    }

    @Test
    void captureRollbackKeepsAllDatabaseIdentitiesAtomicAndRetryDeduplicatesDurableBytes() throws Exception {
        Fixture f = fixture(A);
        long a = analyze(f.initial());
        UUID generationA = currentGeneration(f.project());
        Files.writeString(f.source().resolve(FILE), B);
        Context next = refresh(f);
        transactions.executeWithoutResult(tx -> {
            importStep.run(next);
            long staged = next.snapshotId().orElseThrow();
            assertThat(staged).isNotEqualTo(a);
            assertThat(manifest(staged)).isNotNull();
            assertThat(count("source_manifests", f.project())).isEqualTo(2);
            assertThat(count("analysis_generations", f.project())).isEqualTo(2);
            assertThat(count("source_blobs", f.project())).isEqualTo(2);
            assertThat(currentSnapshot(f.project())).isEqualTo(a);
            assertThat(currentGeneration(f.project())).isEqualTo(generationA);
            tx.setRollbackOnly();
        });
        assertThat(next.snapshotId()).isEmpty();
        assertThat(count("snapshots", f.project())).isEqualTo(1);
        assertThat(count("source_manifests", f.project())).isEqualTo(1);
        assertThat(count("analysis_generations", f.project())).isEqualTo(1);
        assertThat(count("source_blobs", f.project())).isEqualTo(1);
        assertThat(currentSnapshot(f.project())).isEqualTo(a);
        assertThat(currentGeneration(f.project())).isEqualTo(generationA);
        assertThat(files.fileContent(f.project(), f.user(), FILE, a).content()).isEqualTo(A);
        Path durableOrphan = bridge.blob(f.project(), hash(B));
        byte[] alreadyDurable = Files.readAllBytes(durableOrphan);
        long b = analyze(next);
        assertThat(Files.readAllBytes(durableOrphan)).isEqualTo(alreadyDurable);
        assertThat(count("snapshots", f.project())).isEqualTo(2);
        assertThat(count("source_manifests", f.project())).isEqualTo(2);
        assertThat(count("analysis_generations", f.project())).isEqualTo(2);
        assertThat(count("source_blobs", f.project())).isEqualTo(2);
        assertThat(files.fileContent(f.project(), f.user(), FILE, b).content()).isEqualTo(B);
        assertThat(Files.readString(f.source().resolve(FILE))).isEqualTo(B);
    }

    @Test
    void finalizationRollbackPreservesBothCurrentPointersAndTheStagingGeneration() throws Exception {
        Fixture f = fixture(A);
        long a = analyze(f.initial());
        UUID generationA = currentGeneration(f.project());
        Files.writeString(f.source().resolve(FILE), B);
        Context next = refresh(f);
        run(next, importStep);
        run(next, inventoryStep);
        long b = next.snapshotId().orElseThrow();
        UUID generationB = generation(b);
        assertThat(generationStatus(generationB)).isEqualTo("STAGING");
        jobs.markStepRunning(stepId(next, finalizeStep));
        transactions.executeWithoutResult(tx -> {
            finalizeStep.run(next);
            assertThat(currentSnapshot(f.project())).isEqualTo(b);
            assertThat(currentGeneration(f.project())).isEqualTo(generationB);
            assertThat(generationStatus(generationB)).isEqualTo("COMMITTED");
            assertThat(jobs.findJob(next.jobId()).orElseThrow().status()).isEqualTo(JobStatus.DONE);
            assertThat(jobs.findSteps(next.jobId()).stream()
                            .filter(step -> step.stepKey().equals(FinalizeStep.KEY))
                            .findFirst()
                            .orElseThrow()
                            .status())
                    .isEqualTo(StepStatus.DONE);
            tx.setRollbackOnly();
        });
        assertThat(currentSnapshot(f.project())).isEqualTo(a);
        assertThat(currentGeneration(f.project())).isEqualTo(generationA);
        assertThat(generationStatus(generationB)).isEqualTo("STAGING");
        assertThat(jobs.findJob(next.jobId()).orElseThrow().status()).isEqualTo(JobStatus.RUNNING);
        assertThat(jobs.findSteps(next.jobId()).stream()
                        .filter(step -> step.stepKey().equals(FinalizeStep.KEY))
                        .findFirst()
                        .orElseThrow()
                        .status())
                .isEqualTo(StepStatus.RUNNING);
        assertThat(jdbc.queryForObject("select status from snapshots where id=?", String.class, b))
                .isEqualTo("ANALYZING");
        assertThat(files.fileContent(f.project(), f.user(), FILE, a).content()).isEqualTo(A);
        run(next, finalizeStep);
        assertCommittedGeneration(f.project(), b, next.jobId(), generationB, generationA);
    }

    @ParameterizedTest
    @ValueSource(strings = {"CANCELLING", "FAILED"})
    void finalizationRejectsNonRunningJobsAndKeepsThePublishedGeneration(String status) throws Exception {
        Fixture f = fixture(A);
        long a = analyze(f.initial());
        UUID generationA = currentGeneration(f.project());
        Files.writeString(f.source().resolve(FILE), B);
        Context next = refresh(f);
        run(next, importStep);
        run(next, inventoryStep);
        long b = next.snapshotId().orElseThrow();
        UUID generationB = generation(b);
        jobs.markStepRunning(stepId(next, finalizeStep));
        jdbc.update("update analysis_jobs set status=? where id=?", status, next.jobId());

        assertThatThrownBy(() -> finalizeStep.run(next)).isInstanceOf(IllegalStateException.class);

        assertUnpublished(f, a, generationA, b);
        assertThat(generationStatus(generationB)).isEqualTo("STAGING");
        assertThat(jobs.findJob(next.jobId()).orElseThrow().status().name()).isEqualTo(status);
    }

    @ParameterizedTest
    @ValueSource(strings = {"missing", "FAILED", "CANCELLED"})
    void finalizationRequiresAnEligibleRetainedGeneration(String state) throws Exception {
        Fixture f = fixture(A);
        long a = analyze(f.initial());
        UUID generationA = currentGeneration(f.project());
        Files.writeString(f.source().resolve(FILE), B);
        Context next = refresh(f);
        run(next, importStep);
        run(next, inventoryStep);
        long b = next.snapshotId().orElseThrow();
        UUID generationB = generation(b);
        jobs.markStepRunning(stepId(next, finalizeStep));
        if (state.equals("missing")) jdbc.update("delete from analysis_generations where id=?", generationB);
        else jdbc.update("update analysis_generations set status=? where id=?", state, generationB);

        assertThatThrownBy(() -> finalizeStep.run(next)).isInstanceOf(IllegalStateException.class);

        assertUnpublished(f, a, generationA, b);
        assertThat(jobs.findJob(next.jobId()).orElseThrow().status()).isEqualTo(JobStatus.RUNNING);
        if (!state.equals("missing")) assertThat(generationStatus(generationB)).isEqualTo(state);
    }

    @ParameterizedTest
    @ValueSource(strings = {"project", "snapshot"})
    void finalizationRejectsAContextOutsideItsJobProjectAndSnapshot(String mismatch) throws Exception {
        Fixture f = fixture(A);
        long a = analyze(f.initial());
        UUID generationA = currentGeneration(f.project());
        Files.writeString(f.source().resolve(FILE), B);
        Context next = refresh(f);
        run(next, importStep);
        run(next, inventoryStep);
        long b = next.snapshotId().orElseThrow();
        UUID generationB = generation(b);
        jobs.markStepRunning(stepId(next, finalizeStep));
        Fixture other = fixture(A);
        long otherSnapshot = analyze(other.initial());
        UUID otherGeneration = currentGeneration(other.project());
        JobContext forged = overrideContext(
                next,
                mismatch.equals("project") ? other.project() : f.project(),
                mismatch.equals("snapshot") ? otherSnapshot : b);

        assertThatThrownBy(() -> finalizeStep.run(forged)).isInstanceOf(IllegalStateException.class);

        assertUnpublished(f, a, generationA, b);
        assertThat(generationStatus(generationB)).isEqualTo("STAGING");
        assertThat(currentSnapshot(other.project())).isEqualTo(otherSnapshot);
        assertThat(currentGeneration(other.project())).isEqualTo(otherGeneration);
        assertThat(jobs.findJob(next.jobId()).orElseThrow().status()).isEqualTo(JobStatus.RUNNING);
    }

    @Test
    void aSupersededStagingGenerationCannotReplaceANewerPublishedSnapshot() throws Exception {
        Fixture f = fixture(A);
        long a = analyze(f.initial());
        UUID generationA = currentGeneration(f.project());
        Files.writeString(f.source().resolve(FILE), B);
        Context stale = refresh(f);
        run(stale, importStep);
        run(stale, inventoryStep);
        long b = stale.snapshotId().orElseThrow();
        UUID generationB = generation(b);
        jdbc.update("update analysis_jobs set status='FAILED' where id=?", stale.jobId());
        String c = "package demo; class Sample { String value = \"SOURCE_C\"; }\n";
        Files.writeString(f.source().resolve(FILE), c);
        Context current = refresh(f);
        long latest = analyze(current);
        UUID latestGeneration = currentGeneration(f.project());
        assertCommittedGeneration(f.project(), latest, current.jobId(), latestGeneration, generationA);
        // Simulate a stale worker/retry resuming after another generation was published.
        jdbc.update("update analysis_jobs set status='RUNNING' where id=?", stale.jobId());
        jobs.markStepRunning(stepId(stale, finalizeStep));

        assertThatThrownBy(() -> finalizeStep.run(stale)).isInstanceOf(IllegalStateException.class);

        assertUnpublished(f, latest, latestGeneration, b);
        assertThat(generationStatus(generationB)).isEqualTo("STAGING");
        assertThat(files.fileContent(f.project(), f.user(), FILE, a).content()).isEqualTo(A);
        assertThat(files.fileContent(f.project(), f.user(), FILE, latest).content())
                .isEqualTo(c);
    }

    @Test
    void aPublisherFailureAfterFinalizationCannotRewriteTheCommittedJobOrStep() throws Exception {
        Fixture f = fixture(A);
        // fixture() normally starts a job for direct step tests. Let this isolated real worker
        // perform the QUEUED -> RUNNING transition and the complete local three-step pipeline.
        jdbc.update(
                "update analysis_jobs set status='QUEUED',started_at=null where id=?",
                f.initial().jobId());
        JobProgressPublisher publisher = mock(JobProgressPublisher.class);
        AtomicBoolean injected = new AtomicBoolean();
        AtomicReference<Map<String, Object>> committedJob = new AtomicReference<>();
        AtomicReference<Map<String, Object>> committedStep = new AtomicReference<>();
        doAnswer(invocation -> {
                    if (jobs.findJobStatus(f.initial().jobId()).orElseThrow() == JobStatus.DONE
                            && injected.compareAndSet(false, true)) {
                        committedJob.set(jdbc.queryForMap(
                                "select * from analysis_jobs where id=?",
                                f.initial().jobId()));
                        committedStep.set(jdbc.queryForMap(
                                "select * from analysis_job_steps where job_id=? and step_key=?",
                                f.initial().jobId(),
                                FinalizeStep.KEY));
                        throw new IllegalStateException("Synthetic post-commit progress publisher failure");
                    }
                    return null;
                })
                .when(publisher)
                .publish(f.initial().jobId());
        JobWorker isolated = new JobWorker(
                jobs, new Pipeline(List.of(importStep, inventoryStep, finalizeStep)), publisher, app, workspaces);
        try {
            ReflectionTestUtils.invokeMethod(isolated, "runJob", f.initial().jobId());
        } finally {
            ReflectionTestUtils.invokeMethod(isolated, "shutdown");
        }

        assertThat(injected.get()).isTrue();
        assertThat(jdbc.queryForMap(
                        "select * from analysis_jobs where id=?", f.initial().jobId()))
                .isEqualTo(committedJob.get());
        assertThat(jdbc.queryForMap(
                        "select * from analysis_job_steps where job_id=? and step_key=?",
                        f.initial().jobId(),
                        FinalizeStep.KEY))
                .isEqualTo(committedStep.get());
        long snapshot = f.initial().snapshotId().orElseThrow();
        assertCommittedGeneration(f.project(), snapshot, f.initial().jobId(), currentGeneration(f.project()), null);
        assertThat(jobs.findSteps(f.initial().jobId()))
                .allSatisfy(step -> assertThat(step.status()).isEqualTo(StepStatus.DONE));
        assertThat(files.fileContent(f.project(), f.user(), FILE, snapshot).content())
                .isEqualTo(A);
    }

    @Test
    void realWorkerCommitsRetainedSourceAndDeletesItsPlaintextWorkspace() throws Exception {
        Fixture f = fixture(A);
        AtomicReference<Path> usedWorkspace = new AtomicReference<>();
        assertThat(f.initial().clonePath()).doesNotExist();

        runQueuedWorker(f.initial(), mock(JobProgressPublisher.class), usedWorkspace);

        long snapshot = f.initial().snapshotId().orElseThrow();
        assertCommittedGeneration(f.project(), snapshot, f.initial().jobId(), currentGeneration(f.project()), null);
        assertThat(usedWorkspace.get())
                .isNotNull()
                .isNotEqualTo(f.initial().clonePath())
                .doesNotExist();
        assertThat(f.initial().clonePath()).doesNotExist();
        assertNoRunResidue();
        assertThat(files.fileContent(f.project(), f.user(), FILE, snapshot).content())
                .isEqualTo(A);
        assertThat(Files.readString(f.source().resolve(FILE))).isEqualTo(A);
        assertEncryptedBlob(f.project(), A);
    }

    @Test
    void realWorkerFailureAfterImportCleansItsWorkspaceAndKeepsThePublishedSnapshot() throws Exception {
        Fixture f = fixture(A);
        runQueuedWorker(f.initial(), mock(JobProgressPublisher.class), new AtomicReference<>());
        long a = f.initial().snapshotId().orElseThrow();
        UUID generationA = currentGeneration(f.project());
        Files.writeString(f.source().resolve(FILE), B);
        Context next = refresh(f);
        AtomicReference<Path> usedWorkspace = new AtomicReference<>();
        AtomicBoolean injected = new AtomicBoolean();
        JobProgressPublisher publisher = mock(JobProgressPublisher.class);
        doAnswer(invocation -> {
                    boolean imported = jobs.findSteps(next.jobId()).stream()
                            .anyMatch(
                                    step -> step.stepKey().equals(ImportStep.KEY) && step.status() == StepStatus.DONE);
                    if (imported && injected.compareAndSet(false, true)) {
                        assertThat(usedWorkspace.get()).isNotNull().isDirectory();
                        assertThat(Files.readString(usedWorkspace.get().resolve(FILE)))
                                .isEqualTo(B);
                        throw new IllegalStateException("Synthetic failure after retained import");
                    }
                    return null;
                })
                .when(publisher)
                .publish(next.jobId());

        runQueuedWorker(next, publisher, usedWorkspace);

        assertThat(injected.get()).isTrue();
        assertThat(jobs.findJob(next.jobId()).orElseThrow().status()).isEqualTo(JobStatus.FAILED);
        long b = next.snapshotId().orElseThrow();
        assertUnpublished(f, a, generationA, b);
        assertThat(generationStatus(generation(b))).isEqualTo("STAGING");
        assertThat(usedWorkspace.get()).doesNotExist();
        assertThat(f.initial().clonePath()).doesNotExist();
        assertNoRunResidue();
        assertThat(files.fileContent(f.project(), f.user(), FILE, a).content()).isEqualTo(A);
        assertThat(Files.readString(f.source().resolve(FILE))).isEqualTo(B);
    }

    @Test
    void aDirectLeaseReconstructsAStagingSnapshotWithoutTheOriginalOrSharedClone() throws Exception {
        Fixture f = fixture(B);
        runQueuedWorker(f.initial(), mock(JobProgressPublisher.class), new AtomicReference<>());
        long published = f.initial().snapshotId().orElseThrow();
        UUID publishedGeneration = currentGeneration(f.project());
        Files.writeString(f.source().resolve(FILE), A);
        Context next = refresh(f);
        run(next, importStep);
        long staged = next.snapshotId().orElseThrow();
        String commit = jdbc.queryForObject("select commit_sha from snapshots where id=?", String.class, staged);
        var generationBefore = jdbc.queryForMap("select * from analysis_generations where snapshot_id=?", staged);
        var manifestBefore = jdbc.queryForMap("select * from source_manifests where snapshot_id=?", staged);
        deleteFixtureTree(f.source());
        deleteFixtureTree(next.clonePath());

        // This exercises a RUNNING job's immutable input lease directly. It deliberately does
        // not claim that JobService.retry permits this state or that a new process restarted.
        Path reconstructed;
        try (var workspace = workspaces.open(jobs.findJob(next.jobId()).orElseThrow())) {
            reconstructed = workspace.clonePath();
            assertThat(reconstructed).isNotEqualTo(next.clonePath()).isDirectory();
            assertThat(Files.readString(reconstructed.resolve(FILE))).isEqualTo(A);
            try (var git = Git.open(reconstructed.toFile())) {
                assertThat(git.getRepository().resolve(Constants.HEAD).name()).isEqualTo(commit);
            }
            assertUnpublished(f, published, publishedGeneration, staged);
        }

        assertThat(reconstructed).doesNotExist();
        assertThat(f.source()).doesNotExist();
        assertThat(next.clonePath()).doesNotExist();
        assertNoRunResidue();
        assertThat(jdbc.queryForMap("select * from analysis_generations where snapshot_id=?", staged))
                .isEqualTo(generationBefore);
        assertThat(jdbc.queryForMap("select * from source_manifests where snapshot_id=?", staged))
                .isEqualTo(manifestBefore);
        assertThat(jobs.findJob(next.jobId()).orElseThrow().status()).isEqualTo(JobStatus.RUNNING);
        assertThat(files.fileContent(f.project(), f.user(), FILE, published).content())
                .isEqualTo(B);
    }

    @ParameterizedTest
    @ValueSource(strings = {"corrupt", "missing"})
    void failedReconstructionRemovesPartialPlaintextAndPreservesThePublishedGeneration(String failure)
            throws Exception {
        Fixture f = fixture(B);
        runQueuedWorker(f.initial(), mock(JobProgressPublisher.class), new AtomicReference<>());
        long published = f.initial().snapshotId().orElseThrow();
        UUID publishedGeneration = currentGeneration(f.project());
        String firstPath = "a-first.txt";
        String firstSource = "Reconstructed before the second blob fails.\n";
        Files.writeString(f.source().resolve(firstPath), firstSource);
        Files.writeString(f.source().resolve(FILE), A);
        Context next = refresh(f);
        run(next, importStep);
        long staged = next.snapshotId().orElseThrow();
        UUID generation = generation(staged);
        UUID manifest = manifest(staged);
        assertThat(jdbc.queryForList(
                        "select path from source_manifest_entries where manifest_id=? order by path collate \"C\"",
                        String.class,
                        manifest))
                .containsExactly(firstPath, FILE);
        var manifestBefore = jdbc.queryForMap("select * from source_manifests where id=?", manifest);
        deleteFixtureTree(f.source());
        deleteFixtureTree(next.clonePath());
        Path blob = bridge.blob(f.project(), hash(A));
        byte[] encrypted = Files.readAllBytes(blob);
        Path moved = bridge.root.resolve("held-workspace-" + UUID.randomUUID() + ".bin");
        try {
            if (failure.equals("corrupt")) {
                byte[] corrupt = encrypted.clone();
                corrupt[corrupt.length - 1] ^= 1;
                Files.write(blob, corrupt);
            } else Files.move(blob, moved);

            assertThatThrownBy(() -> workspaces.open(jobs.findJob(next.jobId()).orElseThrow()))
                    .isInstanceOf(RetainedRunWorkspace.WorkspaceException.class)
                    .hasMessage("WORKSPACE_SOURCE_UNAVAILABLE");

            assertNoRunResidue();
            assertUnpublished(f, published, publishedGeneration, staged);
            assertThat(generationStatus(generation)).isEqualTo("STAGING");
            assertThat(jobs.findJob(next.jobId()).orElseThrow().status()).isEqualTo(JobStatus.RUNNING);
            assertThat(jdbc.queryForMap("select * from source_manifests where id=?", manifest))
                    .isEqualTo(manifestBefore);
        } finally {
            if (failure.equals("corrupt")) Files.write(blob, encrypted);
            else Files.move(moved, blob);
        }

        // A clean retry of the lease proves the failed attempt released its ownership. This is
        // still direct reconstruction, not acceptance of the public retry route.
        Path recovered;
        try (var workspace = workspaces.open(jobs.findJob(next.jobId()).orElseThrow())) {
            recovered = workspace.clonePath();
            assertThat(Files.readString(recovered.resolve(firstPath))).isEqualTo(firstSource);
            assertThat(Files.readString(recovered.resolve(FILE))).isEqualTo(A);
        }
        assertThat(recovered).doesNotExist();
        assertNoRunResidue();
        assertUnpublished(f, published, publishedGeneration, staged);
        assertThat(files.fileContent(f.project(), f.user(), FILE, published).content())
                .isEqualTo(B);
    }

    @Test
    void publicRetryResumesAnImportedRetainedSnapshotAfterTheOriginalIsDeleted() throws Exception {
        Fixture f = fixture(A);
        Context ctx = f.initial();
        runQueuedWorker(ctx, failureAfterImportedCheckpoint(ctx), new AtomicReference<>());
        assertThat(jobs.findJob(ctx.jobId()).orElseThrow().status()).isEqualTo(JobStatus.FAILED);
        long snapshot = ctx.snapshotId().orElseThrow();
        UUID generation = generation(snapshot);
        var imported = jobs.findSteps(ctx.jobId()).stream()
                .filter(step -> step.stepKey().equals(ImportStep.KEY))
                .findFirst()
                .orElseThrow();
        assertThat(imported.status()).isEqualTo(StepStatus.DONE);
        assertThat(imported.attempt()).isEqualTo(1);
        var manifestBefore = jdbc.queryForMap("select * from source_manifests where snapshot_id=?", snapshot);
        var diagnosticsBefore = diagnosticRows(f.project(), snapshot);
        assertThat(diagnosticsBefore).hasSize(1);
        deleteFixtureTree(f.source());
        assertThat(ctx.clonePath()).doesNotExist();
        assertNoRunResidue();
        clearInvocations(worker);

        jobService.retry(ctx.jobId(), f.user());

        assertThat(jobs.findJob(ctx.jobId()).orElseThrow().status()).isEqualTo(JobStatus.QUEUED);
        verify(worker).dispatch(ctx.jobId());
        assertThat(jobs.findSteps(ctx.jobId()).stream()
                        .filter(step -> step.stepKey().equals(ImportStep.KEY))
                        .findFirst()
                        .orElseThrow())
                .isEqualTo(imported);
        AtomicReference<Path> resumedWorkspace = new AtomicReference<>();
        runWorker(
                ctx,
                new Pipeline(List.of(importStep, inventoryStep, finalizeStep)),
                mock(JobProgressPublisher.class),
                resumedWorkspace);

        assertThat(ctx.snapshotId()).contains(snapshot);
        assertCommittedGeneration(f.project(), snapshot, ctx.jobId(), generation, null);
        assertThat(jobs.findSteps(ctx.jobId()).stream()
                        .filter(step -> step.stepKey().equals(ImportStep.KEY))
                        .findFirst()
                        .orElseThrow())
                .isEqualTo(imported);
        assertThat(jdbc.queryForMap("select * from source_manifests where snapshot_id=?", snapshot))
                .isEqualTo(manifestBefore);
        assertThat(diagnosticRows(f.project(), snapshot)).isEqualTo(diagnosticsBefore);
        assertSingleRetainedSnapshot(f.project());
        assertThat(resumedWorkspace.get()).isNotNull().doesNotExist();
        assertThat(f.source()).doesNotExist();
        assertThat(ctx.clonePath()).doesNotExist();
        assertNoRunResidue();
        assertThat(files.fileContent(f.project(), f.user(), FILE, snapshot).content())
                .isEqualTo(A);
    }

    @Test
    void publicRetryRepairsAnImportStepFailureAfterItsRetainedPublication() throws Exception {
        Fixture f = fixture(A);
        Context ctx = f.initial();
        runQueuedWorker(
                ctx,
                new Pipeline(List.of(importFailingAfterDurablePublication(), inventoryStep, finalizeStep)),
                mock(JobProgressPublisher.class),
                new AtomicReference<>());
        assertThat(jobs.findJob(ctx.jobId()).orElseThrow().status()).isEqualTo(JobStatus.FAILED);
        long snapshot = ctx.snapshotId().orElseThrow();
        UUID generation = generation(snapshot);
        var imported = jobs.findSteps(ctx.jobId()).stream()
                .filter(step -> step.stepKey().equals(ImportStep.KEY))
                .findFirst()
                .orElseThrow();
        assertThat(imported.status()).isEqualTo(StepStatus.FAILED);
        assertThat(imported.attempt()).isEqualTo(1);
        assertThat(generationStatus(generation)).isEqualTo("STAGING");
        var manifestBefore = jdbc.queryForMap("select * from source_manifests where snapshot_id=?", snapshot);
        var diagnosticsBefore = diagnosticRows(f.project(), snapshot);
        assertThat(diagnosticsBefore).hasSize(1);
        byte[] encryptedBefore = Files.readAllBytes(bridge.blob(f.project(), hash(A)));
        deleteFixtureTree(f.source());
        assertThat(ctx.clonePath()).doesNotExist();
        assertNoRunResidue();
        clearInvocations(worker);

        jobService.retry(ctx.jobId(), f.user());

        assertThat(jobs.findJob(ctx.jobId()).orElseThrow().status()).isEqualTo(JobStatus.QUEUED);
        verify(worker).dispatch(ctx.jobId());
        assertThat(jobs.findSteps(ctx.jobId()).stream()
                        .filter(step -> step.stepKey().equals(ImportStep.KEY))
                        .findFirst()
                        .orElseThrow()
                        .status())
                .isEqualTo(StepStatus.PENDING);
        AtomicReference<Path> resumedWorkspace = new AtomicReference<>();
        runWorker(
                ctx,
                new Pipeline(List.of(importStep, inventoryStep, finalizeStep)),
                mock(JobProgressPublisher.class),
                resumedWorkspace);

        assertThat(ctx.snapshotId()).contains(snapshot);
        assertCommittedGeneration(f.project(), snapshot, ctx.jobId(), generation, null);
        var repairedImport = jobs.findSteps(ctx.jobId()).stream()
                .filter(step -> step.stepKey().equals(ImportStep.KEY))
                .findFirst()
                .orElseThrow();
        assertThat(repairedImport.status()).isEqualTo(StepStatus.DONE);
        assertThat(repairedImport.attempt()).isEqualTo(2);
        assertThat(jdbc.queryForMap("select * from source_manifests where snapshot_id=?", snapshot))
                .isEqualTo(manifestBefore);
        assertThat(diagnosticRows(f.project(), snapshot)).isEqualTo(diagnosticsBefore);
        assertThat(Files.readAllBytes(bridge.blob(f.project(), hash(A)))).isEqualTo(encryptedBefore);
        assertSingleRetainedSnapshot(f.project());
        assertThat(resumedWorkspace.get()).isNotNull().doesNotExist();
        assertThat(f.source()).doesNotExist();
        assertThat(ctx.clonePath()).doesNotExist();
        assertNoRunResidue();
        assertThat(files.fileContent(f.project(), f.user(), FILE, snapshot).content())
                .isEqualTo(A);
    }

    @ParameterizedTest
    @ValueSource(strings = {"DONE", "FAILED"})
    void publicRetryRejectsAFailedRetainedJobAfterANewerRefreshWasPublished(String importStatus) throws Exception {
        Fixture f = fixture(A);
        Context stale = f.initial();
        if (importStatus.equals("DONE")) {
            runQueuedWorker(stale, failureAfterImportedCheckpoint(stale), new AtomicReference<>());
        } else {
            runQueuedWorker(
                    stale,
                    new Pipeline(List.of(importFailingAfterDurablePublication(), inventoryStep, finalizeStep)),
                    mock(JobProgressPublisher.class),
                    new AtomicReference<>());
        }
        assertThat(jobs.findJob(stale.jobId()).orElseThrow().status()).isEqualTo(JobStatus.FAILED);
        assertThat(jobs.findSteps(stale.jobId()).stream()
                        .filter(step -> step.stepKey().equals(ImportStep.KEY))
                        .findFirst()
                        .orElseThrow()
                        .status()
                        .name())
                .isEqualTo(importStatus);
        long a = stale.snapshotId().orElseThrow();
        UUID generationA = generation(a);
        Files.writeString(f.source().resolve(FILE), B);
        Context current = refresh(f);
        runQueuedWorker(current, mock(JobProgressPublisher.class), new AtomicReference<>());
        long b = current.snapshotId().orElseThrow();
        UUID generationB = currentGeneration(f.project());
        assertCommittedGeneration(f.project(), b, current.jobId(), generationB, null);
        var staleJobBefore = jdbc.queryForMap("select * from analysis_jobs where id=?", stale.jobId());
        var staleStepsBefore =
                jdbc.queryForList("select * from analysis_job_steps where job_id=? order by seq", stale.jobId());
        var currentJobBefore = jdbc.queryForMap("select * from analysis_jobs where id=?", current.jobId());
        var currentStepsBefore =
                jdbc.queryForList("select * from analysis_job_steps where job_id=? order by seq", current.jobId());
        var generationBefore = jdbc.queryForMap("select * from analysis_generations where id=?", generationB);
        clearInvocations(worker);

        assertThatThrownBy(() -> jobService.retry(stale.jobId(), f.user())).isInstanceOf(JobConflictException.class);

        verifyNoInteractions(worker);
        assertThat(jdbc.queryForMap("select * from analysis_jobs where id=?", stale.jobId()))
                .isEqualTo(staleJobBefore);
        assertThat(jdbc.queryForList("select * from analysis_job_steps where job_id=? order by seq", stale.jobId()))
                .isEqualTo(staleStepsBefore);
        assertThat(jdbc.queryForMap("select * from analysis_jobs where id=?", current.jobId()))
                .isEqualTo(currentJobBefore);
        assertThat(jdbc.queryForList("select * from analysis_job_steps where job_id=? order by seq", current.jobId()))
                .isEqualTo(currentStepsBefore);
        assertThat(jdbc.queryForMap("select * from analysis_generations where id=?", generationB))
                .isEqualTo(generationBefore);
        assertThat(currentSnapshot(f.project())).isEqualTo(b);
        assertThat(currentGeneration(f.project())).isEqualTo(generationB);
        assertThat(generationStatus(generationA)).isEqualTo("STAGING");
        assertThat(files.fileContent(f.project(), f.user(), FILE, b).content()).isEqualTo(B);
        assertNoRunResidue();
    }

    @ParameterizedTest
    @ValueSource(strings = {"corrupt", "missing"})
    void queuedRetryDoesNotStartAnalysisWhenItsRetainedSourceBecomesUnavailable(String failure) throws Exception {
        Fixture f = fixture(B);
        runQueuedWorker(f.initial(), mock(JobProgressPublisher.class), new AtomicReference<>());
        long published = f.initial().snapshotId().orElseThrow();
        UUID publishedGeneration = currentGeneration(f.project());
        Files.writeString(f.source().resolve(FILE), A);
        Context retry = refresh(f);
        runQueuedWorker(retry, failureAfterImportedCheckpoint(retry), new AtomicReference<>());
        assertThat(jobs.findJob(retry.jobId()).orElseThrow().status()).isEqualTo(JobStatus.FAILED);
        long staged = retry.snapshotId().orElseThrow();
        assertUnpublished(f, published, publishedGeneration, staged);
        var metadataBefore = retainedMetadataRows(f.project());
        var publishedDiagnostics = diagnosticRows(f.project(), published);
        var stagedDiagnostics = diagnosticRows(f.project(), staged);
        assertThat(publishedDiagnostics).hasSize(1);
        assertThat(stagedDiagnostics).hasSize(1);
        deleteFixtureTree(f.source());
        assertThat(retry.clonePath()).doesNotExist();
        assertNoRunResidue();
        clearInvocations(worker);

        jobService.retry(retry.jobId(), f.user());

        assertThat(jobs.findJob(retry.jobId()).orElseThrow().status()).isEqualTo(JobStatus.QUEUED);
        verify(worker).dispatch(retry.jobId());
        var queuedSteps = jobs.findSteps(retry.jobId());
        assertThat(queuedSteps.stream()
                        .filter(step -> !step.stepKey().equals(ImportStep.KEY))
                        .toList())
                .hasSize(2)
                .allSatisfy(step -> {
                    assertThat(step.status()).isEqualTo(StepStatus.PENDING);
                    assertThat(step.attempt()).isZero();
                });
        Path blob = bridge.blob(f.project(), hash(A));
        byte[] encrypted = Files.readAllBytes(blob);
        Path moved = bridge.root.resolve("held-queued-retry-" + UUID.randomUUID() + ".bin");
        try {
            // The public retry was accepted while the blob was intact. The worker must verify
            // again when acquiring input, before starting any analysis step.
            if (failure.equals("corrupt")) {
                byte[] corrupt = encrypted.clone();
                corrupt[corrupt.length - 1] ^= 1;
                Files.write(blob, corrupt);
            } else Files.move(blob, moved);
            AtomicReference<Path> deliveredWorkspace = new AtomicReference<>();

            runWorker(
                    retry,
                    new Pipeline(List.of(importStep, inventoryStep, finalizeStep)),
                    mock(JobProgressPublisher.class),
                    deliveredWorkspace);

            assertThat(jobs.findJob(retry.jobId()).orElseThrow().status()).isEqualTo(JobStatus.FAILED);
            assertThat(retry.snapshotId()).contains(staged);
            assertThat(deliveredWorkspace.get()).isNull();
            assertThat(jobs.findSteps(retry.jobId())).isEqualTo(queuedSteps);
            assertThat(retainedMetadataRows(f.project())).isEqualTo(metadataBefore);
            assertThat(diagnosticRows(f.project(), published)).isEqualTo(publishedDiagnostics);
            assertThat(diagnosticRows(f.project(), staged)).isEqualTo(stagedDiagnostics);
            assertThat(jdbc.queryForObject("select count(*) from files where snapshot_id=?", Long.class, staged))
                    .isZero();
            assertUnpublished(f, published, publishedGeneration, staged);
            assertThat(files.fileContent(f.project(), f.user(), FILE, published).content())
                    .isEqualTo(B);
            assertThat(f.source()).doesNotExist();
            assertThat(retry.clonePath()).doesNotExist();
            assertNoRunResidue();
        } finally {
            if (failure.equals("corrupt")) Files.write(blob, encrypted);
            else Files.move(moved, blob);
        }
    }

    @Test
    void diagnosticsFailureRollsBackRetainedPublicationAndKeepsThePreviousSnapshot() throws Exception {
        Fixture f = fixture(B);
        runQueuedWorker(f.initial(), mock(JobProgressPublisher.class), new AtomicReference<>());
        long published = f.initial().snapshotId().orElseThrow();
        UUID publishedGeneration = currentGeneration(f.project());
        var diagnosticsBefore = diagnosticRows(f.project(), published);
        assertThat(diagnosticsBefore).hasSize(1);
        Files.writeString(f.source().resolve(FILE), A);
        Context next = refresh(f);
        AtomicBoolean injected = new AtomicBoolean();
        AtomicReference<Path> usedWorkspace = new AtomicReference<>();
        doAnswer(invocation -> {
                    invocation.callRealMethod();
                    injected.set(true);
                    throw new IllegalStateException("Synthetic diagnostics failure after its database write");
                })
                .when(diagnostics)
                .record(eq(f.project()), anyLong(), any(LocalImportService.ImportSummary.class));
        try {
            runQueuedWorker(next, mock(JobProgressPublisher.class), usedWorkspace);
        } finally {
            doCallRealMethod()
                    .when(diagnostics)
                    .record(eq(f.project()), anyLong(), any(LocalImportService.ImportSummary.class));
        }

        assertThat(injected.get()).isTrue();
        assertThat(jobs.findJob(next.jobId()).orElseThrow().status()).isEqualTo(JobStatus.FAILED);
        assertThat(next.snapshotId()).isEmpty();
        assertThat(currentSnapshot(f.project())).isEqualTo(published);
        assertThat(currentGeneration(f.project())).isEqualTo(publishedGeneration);
        assertSingleRetainedSnapshot(f.project());
        assertThat(count("source_blobs", f.project())).isEqualTo(1);
        assertThat(diagnosticRows(f.project(), published)).isEqualTo(diagnosticsBefore);
        assertThat(jdbc.queryForObject("select count(*) from evidences where project_id=?", Long.class, f.project()))
                .isEqualTo(1);
        assertThat(usedWorkspace.get()).isNotNull().doesNotExist();
        assertThat(next.clonePath()).doesNotExist();
        assertNoRunResidue();
        assertThat(files.fileContent(f.project(), f.user(), FILE, published).content())
                .isEqualTo(B);
        assertThat(Files.readString(f.source().resolve(FILE))).isEqualTo(A);
        // Encryption durability precedes the database transaction; an unreachable encrypted
        // object may remain within the vault quota after rollback.
        assertThat(bridge.blob(f.project(), hash(A))).isRegularFile();
    }

    @Test
    void repeatedSameJobCaptureUsesTheApprovalTimeAndOneSnapshotManifestAndGeneration() throws Exception {
        Fixture f = fixture(A);
        // Equal bytes at two paths are one encrypted blob and two immutable manifest entries.
        Files.writeString(f.source().resolve("duplicate.txt"), A);
        // The first receipt intentionally predates this file. Start a fresh approved job.
        jdbc.update(
                "update analysis_jobs set status='FAILED', error='fixture source expanded' where id=?",
                f.initial().jobId());
        Context current = refresh(f);
        run(current, importStep);
        long snapshot = current.snapshotId().orElseThrow();
        String commit = jdbc.queryForObject("select commit_sha from snapshots where id=?", String.class, snapshot);
        var generationBefore = jdbc.queryForMap("select * from analysis_generations where snapshot_id=?", snapshot);
        var manifestBefore = jdbc.queryForMap("select * from source_manifests where snapshot_id=?", snapshot);
        byte[] encrypted = Files.readAllBytes(bridge.blob(f.project(), hash(A)));
        long firstSecond = Instant.now().getEpochSecond();
        await().pollInterval(Duration.ofMillis(20))
                .atMost(Duration.ofSeconds(3))
                .until(() -> Instant.now().getEpochSecond() > firstSecond);
        run(current, importStep);
        assertThat(current.snapshotId()).contains(snapshot);
        assertThat(count("snapshots", f.project())).isEqualTo(1);
        assertThat(count("source_manifests", f.project())).isEqualTo(1);
        assertThat(count("analysis_generations", f.project())).isEqualTo(1);
        assertThat(count("source_blobs", f.project())).isEqualTo(1);
        assertThat(jdbc.queryForObject(
                        "select count(*) from source_manifest_entries where manifest_id=?",
                        Integer.class,
                        manifest(snapshot)))
                .isEqualTo(2);
        assertThat(jdbc.queryForMap("select * from analysis_generations where snapshot_id=?", snapshot))
                .isEqualTo(generationBefore);
        assertThat(jdbc.queryForMap("select * from source_manifests where snapshot_id=?", snapshot))
                .isEqualTo(manifestBefore);
        assertThat(Files.readAllBytes(bridge.blob(f.project(), hash(A)))).isEqualTo(encrypted);
        var approved = jdbc.queryForObject(
                "select approved_at from job_local_source_inputs where job_id=?",
                OffsetDateTime.class,
                current.jobId());
        try (var git = Git.open(current.clonePath().toFile());
                var walk = new RevWalk(git.getRepository())) {
            var head = git.getRepository().resolve(Constants.HEAD);
            assertThat(head.name()).isEqualTo(commit);
            assertThat(walk.parseCommit(head).getCommitTime()).isEqualTo((int) approved.toEpochSecond());
        }
        run(current, inventoryStep);
        run(current, finalizeStep);
        assertThat(files.fileContent(f.project(), f.user(), FILE, snapshot).content())
                .isEqualTo(A);
        assertThat(Files.readString(f.source().resolve(FILE))).isEqualTo(A);
        assertThat(Files.readString(f.source().resolve("duplicate.txt"))).isEqualTo(A);
    }

    private Fixture fixture(String content) throws Exception {
        String unique = UUID.randomUUID().toString();
        long user = jdbc.queryForObject(
                "insert into users(login,identity_type,local_key) values (?, 'LOCAL', ?) returning id",
                Long.class,
                "retained-fixture-" + unique,
                unique);
        Path source = Files.createDirectories(root.resolve("sources/" + unique));
        Files.createDirectories(source.resolve(FILE).getParent());
        Files.writeString(source.resolve(FILE), content);
        String name = "Retained fixture " + unique;
        var preview = approvals.previewInitial(user, source.toString(), name);
        var created = projects.createFromLocal(
                user, new ProjectController.CreateLocalProjectRequest(source.toString(), name, preview.previewToken()));
        Context initial = context(created.project().id(), created.jobId());
        return new Fixture(user, created.project().id(), source, initial);
    }

    private Context refresh(Fixture f) {
        var preview = approvals.previewRefresh(f.project(), f.user());
        return context(f.project(), projects.reanalyze(f.project(), f.user(), preview.previewToken()));
    }

    private void runQueuedWorker(Context ctx, JobProgressPublisher publisher, AtomicReference<Path> usedWorkspace) {
        runQueuedWorker(ctx, new Pipeline(List.of(importStep, inventoryStep, finalizeStep)), publisher, usedWorkspace);
    }

    private void runQueuedWorker(
            Context ctx, Pipeline pipeline, JobProgressPublisher publisher, AtomicReference<Path> usedWorkspace) {
        jdbc.update("update analysis_jobs set status='QUEUED',started_at=null where id=?", ctx.jobId());
        runWorker(ctx, pipeline, publisher, usedWorkspace);
    }

    private void runWorker(
            Context ctx, Pipeline pipeline, JobProgressPublisher publisher, AtomicReference<Path> usedWorkspace) {
        assertThat(jobs.findJob(ctx.jobId()).orElseThrow().status()).isEqualTo(JobStatus.QUEUED);
        JobWorkspaceProvider observed = job -> {
            var workspace = workspaces.open(job);
            usedWorkspace.set(workspace.clonePath());
            return workspace;
        };
        JobWorker isolated = new JobWorker(jobs, pipeline, publisher, app, observed);
        try {
            ReflectionTestUtils.invokeMethod(isolated, "runJob", ctx.jobId());
        } finally {
            ReflectionTestUtils.invokeMethod(isolated, "shutdown");
        }
    }

    private JobProgressPublisher failureAfterImportedCheckpoint(Context ctx) {
        AtomicBoolean injected = new AtomicBoolean();
        JobProgressPublisher publisher = mock(JobProgressPublisher.class);
        doAnswer(invocation -> {
                    boolean imported = jobs.findSteps(ctx.jobId()).stream()
                            .anyMatch(
                                    step -> step.stepKey().equals(ImportStep.KEY) && step.status() == StepStatus.DONE);
                    if (imported && injected.compareAndSet(false, true))
                        throw new IllegalStateException("Synthetic publisher failure after the import checkpoint");
                    return null;
                })
                .when(publisher)
                .publish(ctx.jobId());
        return publisher;
    }

    private JobStep importFailingAfterDurablePublication() {
        return new JobStep() {
            @Override
            public String key() {
                return ImportStep.KEY;
            }

            @Override
            public void run(JobContext context) {
                importStep.run(context);
                throw new IllegalStateException("Synthetic failure after durable retained publication");
            }
        };
    }

    private List<String> retainedMetadataRows(long project) {
        return jdbc.queryForList("""
                select 'snapshot:' || row_to_json(s)::text || ':' || s.xmin::text
                  from snapshots s where s.project_id=?
                union all
                select 'manifest:' || row_to_json(m)::text || ':' || m.xmin::text
                  from source_manifests m where m.project_id=?
                union all
                select 'generation:' || row_to_json(g)::text || ':' || g.xmin::text
                  from analysis_generations g where g.project_id=?
                union all
                select 'blob:' || row_to_json(b)::text || ':' || b.xmin::text
                  from source_blobs b where b.project_id=?
                union all
                select 'entry:' || row_to_json(e)::text || ':' || e.xmin::text
                  from source_manifest_entries e where e.project_id=?
                order by 1
                """, String.class, project, project, project, project, project);
    }

    private List<String> diagnosticRows(long project, long snapshot) {
        // Preserve identity and xmin as well as JSON content; replay must not silently rewrite
        // the durable observation when the source import was already published.
        return jdbc.queryForList(
                "select row_to_json(e)::text || ':' || e.xmin::text || ':' || row_to_json(l)::text "
                        + "from evidences e join evidence_links l on l.evidence_id=e.id "
                        + "where e.project_id=? and l.subject_type='LOCAL_IMPORT' and l.subject_id=? order by e.id",
                String.class,
                project,
                snapshot);
    }

    private void assertSingleRetainedSnapshot(long project) {
        for (String table : List.of("snapshots", "source_manifests", "analysis_generations")) {
            assertThat(count(table, project)).as(table + " count").isEqualTo(1);
        }
    }

    private void assertNoRunResidue() throws Exception {
        Path scratch = app.reposRoot().resolve(".analysis-runs");
        assertThat(scratch).isDirectory();
        try (var paths = Files.list(scratch)) {
            assertThat(paths.map(path -> path.getFileName().toString()).toList())
                    .containsExactly("owner.lock");
        }
    }

    private void deleteFixtureTree(Path path) throws Exception {
        Path normalized = path.toAbsolutePath().normalize();
        Path fixtureRoot = root.toAbsolutePath().normalize();
        assertThat(normalized.startsWith(fixtureRoot)).isTrue();
        assertThat(normalized).isNotEqualTo(fixtureRoot);
        if (!Files.exists(path)) return;
        try (var paths = Files.walk(path)) {
            for (Path entry : paths.sorted(Comparator.reverseOrder()).toList()) Files.delete(entry);
        }
    }

    private ContextRetrievalService.StructuredRetrieved previewSource(Fixture f, long snapshot) {
        return retrieval.retrievePreviewStructured(
                f.user(),
                f.project(),
                snapshot,
                f.initial().clonePath().toString(),
                new ContextRetrievalService.AskContext("code", FILE, null, null, null, null, null, List.of()),
                "Explain this sample");
    }

    private void assertPreviewSource(ContextRetrievalService.StructuredRetrieved preview, String source) {
        assertThat(preview.blocks().stream()
                        .filter(block -> block.type().equals("SOURCE"))
                        .map(ContextRetrievalService.ContextBlock::content)
                        .toList())
                .containsExactly("SOURCE:\n1|" + source);
        assertThat(preview.fileRefs()).containsExactly("file:" + FILE + ":1");
    }

    private void assertNoSummaryOrUsage(Fixture f) {
        assertThat(jdbc.queryForObject(
                        "select count(*) from summaries sm join snapshots s on s.id=sm.snapshot_id "
                                + "where s.project_id=?",
                        Long.class,
                        f.project()))
                .isZero();
        assertThat(jdbc.queryForObject(
                        "select count(*) from ai_usage_logs where project_id=?", Long.class, f.project()))
                .isZero();
    }

    private Context context(long project, long job) {
        // Only these real local steps run; external analyzers and AI providers are not invoked.
        jdbc.update(
                "delete from analysis_job_steps where job_id=? and step_key not in (?,?,?)",
                job,
                ImportStep.KEY,
                FileInventoryStep.KEY,
                FinalizeStep.KEY);
        assertThat(jobs.markJobRunning(job)).isTrue();
        return new Context(project, job);
    }

    private long analyze(Context ctx) throws Exception {
        run(ctx, importStep);
        run(ctx, inventoryStep);
        run(ctx, finalizeStep);
        assertThat(jobs.findJob(ctx.jobId()).orElseThrow().status()).isEqualTo(JobStatus.DONE);
        return ctx.snapshotId().orElseThrow();
    }

    private void run(Context ctx, JobStep step) throws Exception {
        long stepId = stepId(ctx, step);
        jobs.markStepRunning(stepId);
        step.run(ctx);
        if (!step.key().equals(FinalizeStep.KEY)) jobs.markStepDone(stepId);
    }

    private long stepId(Context ctx, JobStep step) {
        return jobs.findSteps(ctx.jobId()).stream()
                .filter(candidate -> candidate.stepKey().equals(step.key()))
                .findFirst()
                .orElseThrow()
                .id();
    }

    private void assertUnpublished(Fixture f, long publishedSnapshot, UUID publishedGeneration, long stagedSnapshot) {
        assertThat(currentSnapshot(f.project())).isEqualTo(publishedSnapshot);
        assertThat(currentGeneration(f.project())).isEqualTo(publishedGeneration);
        assertThat(jdbc.queryForObject("select status from snapshots where id=?", String.class, stagedSnapshot))
                .isEqualTo("ANALYZING");
        assertThat(jdbc.queryForObject("select status from snapshots where id=?", String.class, publishedSnapshot))
                .isEqualTo("READY");
    }

    private JobContext overrideContext(Context original, long projectId, long snapshotId) {
        return new JobContext() {
            @Override
            public long projectId() {
                return projectId;
            }

            @Override
            public long jobId() {
                return original.jobId();
            }

            @Override
            public JobType jobType() {
                return original.jobType();
            }

            @Override
            public Optional<Long> snapshotId() {
                return Optional.of(snapshotId);
            }

            @Override
            public Path clonePath() {
                return original.clonePath();
            }

            @Override
            public void updateProgress(int progressPct) {
                original.updateProgress(progressPct);
            }

            @Override
            public void attachSnapshot(long value) {
                original.attachSnapshot(value);
            }
        };
    }

    private int count(String table, long project) {
        if (!List.of("snapshots", "source_blobs", "source_manifests", "analysis_generations")
                .contains(table)) throw new AssertionError(table);
        return jdbc.queryForObject("select count(*) from " + table + " where project_id=?", Integer.class, project);
    }

    private long currentSnapshot(long project) {
        return jdbc.queryForObject("select current_snapshot_id from projects where id=?", Long.class, project);
    }

    private UUID currentGeneration(long project) {
        return jdbc.queryForObject("select current_generation_id from projects where id=?", UUID.class, project);
    }

    private UUID manifest(long snapshot) {
        return jdbc.queryForObject("select id from source_manifests where snapshot_id=?", UUID.class, snapshot);
    }

    private UUID generation(long snapshot) {
        return jdbc.queryForObject("select id from analysis_generations where snapshot_id=?", UUID.class, snapshot);
    }

    private String generationStatus(UUID generation) {
        return jdbc.queryForObject("select status from analysis_generations where id=?", String.class, generation);
    }

    private String fileOid(long snapshot) {
        return jdbc.queryForObject(
                "select content_hash from files where snapshot_id=? and path=?", String.class, snapshot, FILE);
    }

    private void assertCommittedGeneration(long project, long snapshot, long job, UUID generation, UUID previous) {
        var row = jdbc.queryForMap("select * from analysis_generations where id=?", generation);
        assertThat(row)
                .containsEntry("project_id", project)
                .containsEntry("snapshot_id", snapshot)
                .containsEntry("job_id", job)
                .containsEntry("status", "COMMITTED")
                .containsEntry("previous_committed_generation_id", previous)
                .containsEntry("producer_version", "legacy-pipeline-source-v1")
                .containsEntry("rules_sha256", null)
                .containsEntry("config_sha256", null)
                .containsEntry("dependency_context_sha256", null);
        assertThat(row.get("committed_at")).isNotNull();
        assertThat(currentSnapshot(project)).isEqualTo(snapshot);
        assertThat(currentGeneration(project)).isEqualTo(generation);
        assertThat(jdbc.queryForObject("select status from snapshots where id=?", String.class, snapshot))
                .isEqualTo("READY");
        assertThat(jdbc.queryForObject(
                        "select sealed_at is not null from source_manifests where id=?",
                        Boolean.class,
                        row.get("source_manifest_id")))
                .isTrue();
        assertThat(jobs.findJob(job).orElseThrow().status()).isEqualTo(JobStatus.DONE);
        assertThat(jobs.findSteps(job).stream()
                        .filter(step -> step.stepKey().equals(FinalizeStep.KEY))
                        .findFirst()
                        .orElseThrow()
                        .status())
                .isEqualTo(StepStatus.DONE);
    }

    private void assertEncryptedBlob(long project, String plaintext) throws Exception {
        Path file = bridge.blob(project, hash(plaintext));
        assertThat(new String(Files.readAllBytes(file), StandardCharsets.ISO_8859_1))
                .doesNotContain(plaintext);
        assertThat(Files.getPosixFilePermissions(file)).isEqualTo(PosixFilePermissions.fromString("rw-------"));
        assertThat(jdbc.queryForObject(
                        "select sha256 from source_blobs where project_id=? and sha256=?",
                        String.class,
                        project,
                        hash(plaintext)))
                .hasSize(64);
    }

    private static String hash(String text) {
        try {
            return HexFormat.of()
                    .formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }

    private static void gone(ThrowingCallable operation) {
        assertThatThrownBy(operation)
                .isInstanceOf(SnapshotSourceException.class)
                .satisfies(error -> {
                    var response = (SnapshotSourceException) error;
                    assertThat(response.getStatusCode()).isEqualTo(HttpStatus.GONE);
                    assertThat(response.getBody().getProperties()).containsEntry("code", "SOURCE_UNAVAILABLE");
                    assertThat(response.getBody().getDetail()).doesNotContain(A, B, NodeBridge.TOKEN);
                });
    }

    private static void notFound(ThrowingCallable operation) {
        assertThatThrownBy(operation)
                .isInstanceOf(ErrorResponseException.class)
                .satisfies(error -> assertThat(((ErrorResponseException) error).getStatusCode())
                        .isEqualTo(HttpStatus.NOT_FOUND));
    }

    private record Fixture(long user, long project, Path source, Context initial) {}

    private final class Context implements JobContext {
        private final long project;
        private final long job;

        Context(long project, long job) {
            this.project = project;
            this.job = job;
        }

        @Override
        public long projectId() {
            return project;
        }

        @Override
        public long jobId() {
            return job;
        }

        @Override
        public JobType jobType() {
            return jobs.findJob(job).orElseThrow().type();
        }

        @Override
        public Optional<Long> snapshotId() {
            return Optional.ofNullable(jobs.findJob(job).orElseThrow().snapshotId());
        }

        @Override
        public Path clonePath() {
            return app.reposRoot().resolve(Long.toString(project));
        }

        @Override
        public void updateProgress(int progressPct) {
            /* This test drives only the concrete local steps. */
        }

        @Override
        public void attachSnapshot(long snapshotId) {
            jobs.attachSnapshot(job, snapshotId);
        }
    }

    private static final class NodeBridge implements AutoCloseable {
        private static final String TOKEN = "c".repeat(64); // Public fixture capability, never a source root key.
        private final Path root;
        private final Path socket;
        private final Path config;
        private final Path stderr;
        private Process process;
        private BufferedReader stdout;

        NodeBridge() throws Exception {
            root = Files.createTempDirectory(
                            Path.of("/tmp"),
                            "ci-retained-",
                            PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")))
                    .toRealPath();
            socket = root.resolve("broker.sock");
            config = Files.createFile(
                    root.resolve("config.json"),
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
            stderr = Files.createFile(
                    root.resolve("stderr.log"),
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
            Files.writeString(
                    config,
                    JsonMapper.builder()
                            .build()
                            .writeValueAsString(Map.of(
                                    "root", root.toString(), "socketPath", socket.toString(), "authToken", TOKEN)));
        }

        synchronized void start() throws Exception {
            if (process != null && process.isAlive()) return;
            Path fixture = Path.of("../desktop/test/fixtures/source-store-server.cjs")
                    .toAbsolutePath()
                    .normalize();
            assertThat(fixture).isRegularFile();
            process = new ProcessBuilder("node", fixture.toString(), config.toString())
                    .redirectError(stderr.toFile())
                    .start();
            stdout = process.inputReader(StandardCharsets.UTF_8);
            var readers = Executors.newVirtualThreadPerTaskExecutor();
            var ready = readers.submit(stdout::readLine);
            try {
                assertThat(ready.get(10, TimeUnit.SECONDS)).isEqualTo("READY");
            } catch (Throwable error) {
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
                throw error;
            } finally {
                readers.shutdownNow();
                assertThat(readers.awaitTermination(2, TimeUnit.SECONDS)).isTrue();
            }
            assertThat(Files.readString(stderr)).isEmpty();
        }

        synchronized void stop() throws Exception {
            if (process == null) return;
            if (process.isAlive()) {
                process.getOutputStream().write("stop\n".getBytes(StandardCharsets.UTF_8));
                process.getOutputStream().flush();
                if (!process.waitFor(15, TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                    throw new AssertionError("Disposable source bridge did not stop");
                }
            }
            assertThat(process.exitValue()).isZero();
            assertThat(stdout.readLine()).isNull();
            assertThat(Files.readString(stderr)).isEmpty();
            stdout.close();
            process = null;
        }

        Path blob(long project, String hash) {
            return root.resolve("blobs")
                    .resolve(Long.toString(project))
                    .resolve(hash)
                    .resolve("blob.bin");
        }

        @Override
        public void close() throws Exception {
            stop();
            try (var paths = Files.walk(root)) {
                for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.delete(path);
            }
        }
    }
}
