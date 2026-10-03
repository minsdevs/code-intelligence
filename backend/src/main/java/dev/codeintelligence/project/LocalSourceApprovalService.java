package dev.codeintelligence.project;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.Semaphore;
import java.util.function.Supplier;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Server-owned preview authority. Neither a renderer digest nor a live path is a job receipt. */
@Service
public class LocalSourceApprovalService {
    private static final int MAX_UNEXPIRED_PREVIEWS = 16;
    private static final String BINDING_COLUMNS = "schema_version, canonical_root, root_device, root_inode, "
            + "policy_version, limits_sha256, manifest_sha256, selected_files, selected_bytes";
    private static final String BINDING_VALUES =
            ":schema, :root, :device, :inode, :policy, :limits, :manifest, :files, :bytes";
    private final JdbcClient jdbc;
    private final LocalImportService imports;
    private final TransactionTemplate transactions;
    private final SecureRandom random = new SecureRandom();
    private final Semaphore inspections = new Semaphore(2);

    public LocalSourceApprovalService(JdbcClient jdbc, LocalImportService imports, TransactionTemplate transactions) {
        this.jdbc = jdbc;
        this.imports = imports;
        this.transactions = transactions;
    }

    record ProjectContext(long id, long userId, String sourceType, String path, Long snapshotId) {}

    record PreparedApproval(
            long id,
            String tokenHash,
            long userId,
            String purpose,
            Long projectId,
            Long snapshotId,
            String projectName,
            LocalSourceBinding binding) {}

    private record Changes(LocalSourcePreview.Changes counts, List<String> paths) {}

    private record Receipt(LocalSourceBinding binding, Long baseSnapshotId, ProjectContext project, String status) {}

    public record Outcome(String state, Long projectId, Long jobId) {}

    public LocalSourcePreview previewInitial(long userId, String path, String name) {
        return boundedInspection(() -> {
            checkQuota(userId);
            LocalSourceInspection inspection = imports.inspect(sourcePath(path));
            String projectName = projectName(name, inspection.binding());
            Changes changes = changes(inspection.gitFingerprints(), Map.of());
            return transactions.execute(tx -> {
                lockPreviewOwner(userId);
                checkQuota(userId);
                verifyRoot(inspection.binding(), path);
                return issue(userId, "INITIAL", null, null, projectName, inspection, changes);
            });
        });
    }

    public LocalSourcePreview previewRefresh(long projectId, long userId) {
        return boundedInspection(() -> {
            ProjectContext before = project(projectId, userId, false);
            requireLocal(before);
            requireIdle(projectId);
            checkQuota(userId);
            LocalSourceInspection inspection = imports.inspect(sourcePath(before.path()));
            Changes changes = changes(inspection.gitFingerprints(), snapshotFingerprint(before));
            return transactions.execute(tx -> {
                ProjectContext current = project(projectId, userId, true);
                // Project precedes any approval row, including expired-row cleanup.
                lockPreviewOwner(userId);
                requireLocal(current);
                requireSameProjectSource(before, current);
                requireIdle(projectId);
                checkQuota(userId);
                verifyRoot(inspection.binding(), current.path());
                return issue(userId, "REFRESH", projectId, current.snapshotId(), null, inspection, changes);
            });
        });
    }

    PreparedApproval prepareInitial(long userId, String token, String path, String name) {
        requireTransaction();
        PreparedApproval approval = lockApproval(userId, token);
        if (!"INITIAL".equals(approval.purpose())
                || approval.projectId() != null
                || !Objects.equals(approval.projectName(), projectName(name, approval.binding()))) {
            throw LocalSourceApprovalException.invalid();
        }
        verifyRoot(approval.binding(), path);
        return approval;
    }

    PreparedApproval prepareRefresh(long userId, long projectId, String token) {
        requireTransaction();
        // The project lock must precede the token lock for every existing-project operation.
        ProjectContext current = project(projectId, userId, true);
        requireLocal(current);
        requireIdle(projectId);
        PreparedApproval approval = lockApproval(userId, token);
        if (!"REFRESH".equals(approval.purpose()) || !Objects.equals(approval.projectId(), projectId)) {
            throw LocalSourceApprovalException.invalid();
        }
        if (!Objects.equals(approval.snapshotId(), current.snapshotId())) throw baseChanged();
        verifyRoot(approval.binding(), current.path());
        return approval;
    }

    void bind(PreparedApproval approval, long projectId, long jobId) {
        requireTransaction();
        ProjectContext current = project(projectId, approval.userId(), true);
        requireLocal(current);
        if (!Objects.equals(current.snapshotId(), approval.snapshotId())) throw baseChanged();
        verifyRoot(approval.binding(), current.path());
        boolean queued = Boolean.TRUE.equals(jdbc.sql("select exists(select 1 from analysis_jobs "
                        + "where id = :job and project_id = :project and status = 'QUEUED')")
                .param("job", jobId)
                .param("project", projectId)
                .query(Boolean.class)
                .single());
        if (!queued) throw LocalSourceApprovalException.invalid();
        // A separate statement AFTER row-lock acquisition evaluates the actual wall clock.
        int consumed = jdbc.sql(
                        "update local_source_approvals set consumed_at = clock_timestamp(), consumed_job_id = :job "
                                + "where id = :id and user_id = :user and consumed_at is null and revoked_at is null "
                                + "and issued_at <= clock_timestamp() and expires_at > clock_timestamp()")
                .param("job", jobId)
                .param("id", approval.id())
                .param("user", approval.userId())
                .update();
        if (consumed != 1) throw expired();
        int inserted = jdbc.sql(
                        "insert into job_local_source_inputs (job_id, project_id, approval_token_sha256, purpose, "
                                + "base_snapshot_id, " + BINDING_COLUMNS + ", approved_at) "
                                + "select :job, :project, token_sha256, purpose, base_snapshot_id, " + BINDING_COLUMNS
                                + ", consumed_at from local_source_approvals where id = :id and consumed_job_id = :job")
                .param("job", jobId)
                .param("project", projectId)
                .param("id", approval.id())
                .update();
        if (inserted != 1) throw LocalSourceApprovalException.invalid();
    }

    public LocalSourceBinding requireJobInput(long jobId, long projectId) {
        Receipt receipt = receipt(jobId, projectId);
        verifyReceipt(receipt);
        return receipt.binding();
    }

    public void verifyBeforePublish(long jobId, long projectId) {
        transactions.executeWithoutResult(tx -> {
            jdbc.sql("select id from projects where id = :id for update")
                    .param("id", projectId)
                    .query(Long.class)
                    .optional()
                    .orElseThrow(LocalSourceApprovalException::invalid);
            verifyReceipt(receipt(jobId, projectId));
        });
    }

    /** Resolves an uncertain confirmation without ever issuing another job or approval. */
    public Outcome outcome(long userId, String token) {
        String hash = tokenHash(token);
        return transactions.execute(tx -> {
            Long approvalId = jdbc.sql("select id from local_source_approvals "
                            + "where token_sha256 = :hash and user_id = :user for update")
                    .param("hash", hash)
                    .param("user", userId)
                    .query(Long.class)
                    .optional()
                    .orElse(null);
            // The copied hash survives preview cleanup; project ownership still controls access.
            Outcome consumed = jdbc.sql("select i.project_id, i.job_id from job_local_source_inputs i "
                            + "join projects p on p.id = i.project_id "
                            + "join analysis_jobs j on j.id = i.job_id and j.project_id = p.id "
                            + "where i.approval_token_sha256 = :hash and p.user_id = :user")
                    .param("hash", hash)
                    .param("user", userId)
                    .query((rs, row) -> new Outcome("CONSUMED", rs.getLong("project_id"), rs.getLong("job_id")))
                    .optional()
                    .orElse(null);
            if (consumed != null) return consumed;
            if (approvalId != null) {
                jdbc.sql("update local_source_approvals set revoked_at = coalesce(revoked_at, clock_timestamp()) "
                                + "where id = :id and consumed_at is null")
                        .param("id", approvalId)
                        .update();
            }
            // Revocation under the same lock prevents a delayed original confirmation from succeeding.
            return new Outcome("ABANDONED", null, null);
        });
    }

    private LocalSourcePreview issue(
            long userId,
            String purpose,
            Long projectId,
            Long snapshotId,
            String name,
            LocalSourceInspection inspection,
            Changes changes) {
        byte[] tokenBytes = new byte[32];
        random.nextBytes(tokenBytes);
        String token = HexFormat.of().formatHex(tokenBytes);
        var statement = jdbc.sql("with issued as (select clock_timestamp() as time) "
                        + "insert into local_source_approvals (token_sha256, user_id, purpose, project_id, base_snapshot_id, "
                        + "project_name, " + BINDING_COLUMNS + ", issued_at, expires_at) "
                        + "select :hash, :user, :purpose, :project, :snapshot, :name, " + BINDING_VALUES
                        + ", time, time + interval '10 minutes' from issued returning expires_at")
                .param("hash", tokenHash(token))
                .param("user", userId)
                .param("purpose", purpose)
                .param("project", projectId)
                .param("snapshot", snapshotId)
                .param("name", name);
        Instant expires = bindingParams(statement, inspection.binding())
                .query((rs, row) ->
                        rs.getObject("expires_at", OffsetDateTime.class).toInstant())
                .single();
        return new LocalSourcePreview(
                token,
                expires,
                purpose,
                Path.of(inspection.binding().canonicalRoot()).getFileName().toString(),
                snapshotId,
                changes.counts(),
                changes.paths(),
                inspection.summary());
    }

    private PreparedApproval lockApproval(long userId, String token) {
        String hash = tokenHash(token);
        Long id = jdbc.sql("select id from local_source_approvals "
                        + "where token_sha256 = :hash and user_id = :user for update")
                .param("hash", hash)
                .param("user", userId)
                .query(Long.class)
                .optional()
                .orElseThrow(LocalSourceApprovalException::invalid);
        // Do not evaluate clock_timestamp in the SELECT projection that can wait for a lock.
        return jdbc.sql("select *, issued_at <= clock_timestamp() and expires_at > clock_timestamp() as live "
                        + "from local_source_approvals where id = :id")
                .param("id", id)
                .query((rs, row) -> {
                    if (rs.getObject("consumed_at") != null) {
                        throw new LocalSourceApprovalException(
                                "LOCAL_PREVIEW_CONSUMED",
                                "This preview was already used. Check its operation before starting a new preview.");
                    }
                    if (rs.getObject("revoked_at") != null) throw LocalSourceApprovalException.invalid();
                    if (!rs.getBoolean("live")) throw expired();
                    return new PreparedApproval(
                            id,
                            hash,
                            userId,
                            rs.getString("purpose"),
                            rs.getObject("project_id", Long.class),
                            rs.getObject("base_snapshot_id", Long.class),
                            rs.getString("project_name"),
                            binding(rs));
                })
                .single();
    }

    private Receipt receipt(long jobId, long projectId) {
        return jdbc.sql("select i.*, p.user_id as owner_id, p.source_type, p.local_path, "
                        + "p.current_snapshot_id, j.status as job_status from job_local_source_inputs i "
                        + "join analysis_jobs j on j.id = i.job_id and j.project_id = i.project_id "
                        + "join projects p on p.id = i.project_id where i.job_id = :job and i.project_id = :project")
                .param("job", jobId)
                .param("project", projectId)
                .query((rs, row) -> new Receipt(
                        binding(rs),
                        rs.getObject("base_snapshot_id", Long.class),
                        new ProjectContext(
                                projectId,
                                rs.getLong("owner_id"),
                                rs.getString("source_type"),
                                rs.getString("local_path"),
                                rs.getObject("current_snapshot_id", Long.class)),
                        rs.getString("job_status")))
                .optional()
                .orElseThrow(LocalSourceApprovalException::invalid);
    }

    private void verifyReceipt(Receipt receipt) {
        requireLocal(receipt.project());
        if (!"RUNNING".equals(receipt.status())
                || !Objects.equals(receipt.baseSnapshotId(), receipt.project().snapshotId())) throw baseChanged();
        verifyRoot(receipt.binding(), receipt.project().path());
    }

    private ProjectContext project(long id, long userId, boolean lock) {
        return jdbc.sql("select id, user_id, source_type, local_path, current_snapshot_id from projects "
                        + "where id = :id and user_id = :user" + (lock ? " for update" : ""))
                .param("id", id)
                .param("user", userId)
                .query((rs, row) -> new ProjectContext(
                        rs.getLong("id"),
                        rs.getLong("user_id"),
                        rs.getString("source_type"),
                        rs.getString("local_path"),
                        rs.getObject("current_snapshot_id", Long.class)))
                .optional()
                .orElseThrow(ProjectNotFoundException::new);
    }

    private Map<String, String> snapshotFingerprint(ProjectContext project) {
        if (project.snapshotId() == null) return Map.of();
        boolean owned = Boolean.TRUE.equals(
                jdbc.sql("select exists(select 1 from snapshots " + "where id = :snapshot and project_id = :project)")
                        .param("snapshot", project.snapshotId())
                        .param("project", project.id())
                        .query(Boolean.class)
                        .single());
        if (!owned) throw baseChanged();
        Map<String, String> result = new LinkedHashMap<>();
        jdbc.sql("select path, content_hash from files where snapshot_id = :snapshot order by path")
                .param("snapshot", project.snapshotId())
                .query((rs, row) -> {
                    result.put(rs.getString("path"), rs.getString("content_hash"));
                    return 0;
                })
                .list();
        return result;
    }

    private static Changes changes(Map<String, String> current, Map<String, String> previous) {
        int added = 0, modified = 0, deleted = 0;
        List<String> paths = new ArrayList<>();
        for (var entry : current.entrySet()) {
            if (!previous.containsKey(entry.getKey())) {
                added++;
                paths.add("A " + entry.getKey());
            } else if (!Objects.equals(entry.getValue(), previous.get(entry.getKey()))) {
                modified++;
                paths.add("M " + entry.getKey());
            }
        }
        for (String path : previous.keySet())
            if (!current.containsKey(path)) {
                deleted++;
                paths.add("D " + path);
            }
        paths.sort(String::compareTo);
        return new Changes(
                LocalSourcePreview.Changes.of(added, modified, deleted),
                paths.stream().limit(100).toList());
    }

    private void verifyRoot(LocalSourceBinding binding, String submittedPath) {
        try {
            Path resolved = imports.validateSource(sourcePath(submittedPath));
            Map<String, Object> identity = Files.readAttributes(resolved, "unix:dev,ino", LinkOption.NOFOLLOW_LINKS);
            if (!resolved.toString().equals(binding.canonicalRoot())
                    || ((Number) identity.get("dev")).longValue() != binding.rootDevice()
                    || ((Number) identity.get("ino")).longValue() != binding.rootInode()) {
                throw LocalSourceApprovalException.sourceChanged();
            }
        } catch (IOException | RuntimeException ex) {
            throw LocalSourceApprovalException.sourceChanged();
        }
    }

    private void lockPreviewOwner(long userId) {
        // Compatible with project/user FK key-share checks during initial confirmation.
        jdbc.sql("select id from users where id = :id for no key update")
                .param("id", userId)
                .query(Long.class)
                .optional()
                .orElseThrow(LocalSourceApprovalException::invalid);
        jdbc.sql("delete from local_source_approvals where user_id = :id and expires_at <= clock_timestamp()")
                .param("id", userId)
                .update();
    }

    private void checkQuota(long userId) {
        long count = jdbc.sql("select count(*) from local_source_approvals "
                        + "where user_id = :user and expires_at > clock_timestamp()")
                .param("user", userId)
                .query(Long.class)
                .single();
        if (count >= MAX_UNEXPIRED_PREVIEWS) throw busy();
    }

    private void requireIdle(long projectId) {
        boolean active = Boolean.TRUE.equals(jdbc.sql("select exists(select 1 from analysis_jobs "
                        + "where project_id = :project and status in ('QUEUED', 'RUNNING', 'CANCELLING'))")
                .param("project", projectId)
                .query(Boolean.class)
                .single());
        if (active) throw busy();
    }

    private <T> T boundedInspection(Supplier<T> operation) {
        if (!inspections.tryAcquire()) throw busy();
        try {
            return operation.get();
        } finally {
            inspections.release();
        }
    }

    private static void requireLocal(ProjectContext project) {
        if (!"LOCAL".equals(project.sourceType())) throw LocalSourceApprovalException.invalid();
    }

    private static void requireSameProjectSource(ProjectContext before, ProjectContext after) {
        if (!Objects.equals(before.path(), after.path()) || !Objects.equals(before.snapshotId(), after.snapshotId())) {
            throw baseChanged();
        }
    }

    private static Path sourcePath(String path) {
        if (path == null || path.isBlank() || path.length() > 16384) throw LocalSourceApprovalException.invalid();
        try {
            return Path.of(path);
        } catch (RuntimeException ex) {
            throw LocalSourceApprovalException.invalid();
        }
    }

    private static String projectName(String submitted, LocalSourceBinding binding) {
        String name = submitted == null || submitted.isBlank()
                ? Path.of(binding.canonicalRoot()).getFileName().toString()
                : submitted.trim();
        if (name.isBlank() || name.length() > 255 || name.chars().anyMatch(Character::isISOControl)) {
            throw LocalSourceApprovalException.invalid();
        }
        return name;
    }

    static String tokenHash(String token) {
        if (token == null || !token.matches("[0-9a-f]{64}")) throw LocalSourceApprovalException.invalid();
        try {
            return HexFormat.of()
                    .formatHex(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 unavailable", ex);
        }
    }

    private static LocalSourceBinding binding(ResultSet rs) throws SQLException {
        return new LocalSourceBinding(
                rs.getInt("schema_version"),
                rs.getString("canonical_root"),
                rs.getLong("root_device"),
                rs.getLong("root_inode"),
                rs.getString("policy_version"),
                rs.getString("limits_sha256"),
                rs.getString("manifest_sha256"),
                rs.getInt("selected_files"),
                rs.getLong("selected_bytes"));
    }

    private static JdbcClient.StatementSpec bindingParams(
            JdbcClient.StatementSpec statement, LocalSourceBinding binding) {
        return statement
                .param("schema", binding.schemaVersion())
                .param("root", binding.canonicalRoot())
                .param("device", binding.rootDevice())
                .param("inode", binding.rootInode())
                .param("policy", binding.policyVersion())
                .param("limits", binding.limitsSha256())
                .param("manifest", binding.manifestSha256())
                .param("files", binding.selectedFiles())
                .param("bytes", binding.selectedBytes());
    }

    private static void requireTransaction() {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Approval consumption requires the job creation transaction");
        }
    }

    private static LocalSourceApprovalException expired() {
        return new LocalSourceApprovalException(
                "LOCAL_PREVIEW_EXPIRED", "This preview expired. Create and confirm a new preview.");
    }

    private static LocalSourceApprovalException baseChanged() {
        return new LocalSourceApprovalException(
                "LOCAL_PREVIEW_BASE_CHANGED", "The project source or snapshot changed. Create a new preview.");
    }

    private static LocalSourceApprovalException busy() {
        return new LocalSourceApprovalException(
                "LOCAL_PREVIEW_BUSY", "A source operation is busy. Wait and request a new preview.");
    }
}
