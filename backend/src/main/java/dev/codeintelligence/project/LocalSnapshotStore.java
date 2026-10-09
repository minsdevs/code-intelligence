package dev.codeintelligence.project;

import dev.codeintelligence.source.SourceStoreClient;
import dev.codeintelligence.source.SourceStoreException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.ObjectInserter;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Publishes immutable source metadata only after the main-owned blob store acknowledges durability:
 * blobs are staged in vault batches and one barrier covering the whole capture precedes the commit.
 */
@Service
public class LocalSnapshotStore {
    private final SourceStoreClient client;
    private final JdbcClient jdbc;
    private final NamedParameterJdbcTemplate batches;
    private final TransactionTemplate transactions;
    private final LocalSourceApprovalService approvals;
    private final LocalImportDiagnostics diagnostics;

    public LocalSnapshotStore(
            SourceStoreClient client,
            JdbcClient jdbc,
            NamedParameterJdbcTemplate batches,
            TransactionTemplate transactions,
            LocalSourceApprovalService approvals,
            LocalImportDiagnostics diagnostics) {
        this.client = client;
        this.jdbc = jdbc;
        this.batches = batches;
        this.transactions = transactions;
        this.approvals = approvals;
        this.diagnostics = diagnostics;
    }

    public boolean enabled() {
        return client.enabled();
    }

    public Capture begin(long projectId, long jobId, LocalSourceBinding binding) {
        if (!client.enabled() || !binding.equals(approvals.requireJobInput(jobId, projectId))) {
            throw LocalSourceApprovalException.invalid();
        }
        Instant time = jdbc.sql(
                        "select approved_at from job_local_source_inputs where job_id=:job and project_id=:project")
                .param("job", jobId)
                .param("project", projectId)
                .query((rs, row) ->
                        rs.getObject("approved_at", OffsetDateTime.class).toInstant())
                .single();
        var reusable = new java.util.HashMap<String, SourceStoreClient.StoredBlob>();
        jdbc.sql("select distinct b.sha256,b.byte_size,b.key_id from projects p "
                        + "join analysis_generations g on g.id=p.current_generation_id and g.project_id=p.id "
                        + "join source_manifests m on m.id=g.source_manifest_id and m.project_id=p.id "
                        + "join source_manifest_entries e on e.manifest_id=m.id and e.project_id=p.id "
                        + "join source_blobs b on b.project_id=e.project_id and b.sha256=e.blob_sha256 "
                        + "where p.id=:project and g.status='COMMITTED' and m.sealed_at is not null")
                .param("project", projectId)
                .query((rs, row) -> new SourceStoreClient.StoredBlob(
                        rs.getString("sha256"), rs.getLong("byte_size"), rs.getString("key_id")))
                .list()
                .forEach(blob -> reusable.put(blob.sha256(), blob));
        return new Capture(projectId, jobId, binding, time, reusable);
    }

    private record Entry(String path, String gitOid, SourceStoreClient.StoredBlob blob) {}

    public final class Capture implements LocalImportService.VerifiedFileSink {
        private final long projectId;
        private final long jobId;
        private final LocalSourceBinding binding;
        private final Instant approvedAt;
        private final LocalSourceManifest digest;
        private final List<Entry> entries = new ArrayList<>();
        private final Map<String, SourceStoreClient.StoredBlob> reusable;
        private final Map<String, SourceStoreClient.StoredBlob> retained = new java.util.LinkedHashMap<>();
        private final MessageDigest hashes = sha256Digest();
        private String session;
        private long sequence;
        private boolean finished;

        private Capture(
                long projectId,
                long jobId,
                LocalSourceBinding binding,
                Instant approvedAt,
                Map<String, SourceStoreClient.StoredBlob> reusable) {
            this.projectId = projectId;
            this.jobId = jobId;
            this.binding = binding;
            this.approvedAt = approvedAt;
            this.digest = new LocalSourceManifest(binding.policyVersion(), binding.limitsSha256());
            this.reusable = reusable;
        }

        @Override
        public Instant commitTime() {
            return approvedAt;
        }

        @Override
        public void accept(String path, String gitOid, byte[] bytes) {
            if (finished
                    || !safePath(path)
                    || entries.size() >= binding.selectedFiles()
                    || !ObjectId.isId(gitOid)
                    || path.getBytes(StandardCharsets.UTF_8).length > 8192) {
                throw LocalSourceApprovalException.sourceChanged();
            }
            try (var formatter = new ObjectInserter.Formatter()) {
                if (!formatter.idFor(Constants.OBJ_BLOB, bytes).name().equals(gitOid))
                    throw LocalSourceApprovalException.sourceChanged();
            }
            String sha256 = HexFormat.of().formatHex(hashes.digest(bytes));
            var blob = reusable.get(sha256);
            if (blob != null && blob.byteSize() == bytes.length) {
                retained.putIfAbsent(sha256, blob);
            } else {
                var staged = client.stage(projectId, bytes);
                // A reopened vault dropped whatever an earlier session staged but never flushed.
                if (session == null) session = staged.session();
                else if (!session.equals(staged.session())) throw SourceStoreException.unavailable();
                if (staged.sequence() <= sequence) throw SourceStoreException.integrity();
                sequence = staged.sequence();
                blob = staged.blob();
            }
            digest.add(path, bytes.length, HexFormat.of().parseHex(sha256));
            if (digest.bytes() > binding.selectedBytes()) throw LocalSourceApprovalException.sourceChanged();
            entries.add(new Entry(path, gitOid, blob));
        }

        public long publish(String commitOid, LocalImportService.ImportSummary summary) {
            if (finished || !ObjectId.isId(commitOid)) throw LocalSourceApprovalException.invalid();
            finished = true;
            if (!digest.finish().equals(binding.manifestSha256())
                    || digest.count() != binding.selectedFiles()
                    || digest.bytes() != binding.selectedBytes()) throw LocalSourceApprovalException.sourceChanged();
            var references = new ArrayList<>(retained.values());
            for (int offset = 0; offset < references.size(); offset += 128) {
                dev.codeintelligence.job.JobCancellation.checkpoint();
                client.retain(projectId, references.subList(offset, Math.min(offset + 128, references.size())));
            }
            if (session != null) client.barrier(session, sequence);
            return Objects.requireNonNull(transactions.execute(tx -> {
                jdbc.sql("select id from projects where id=:project for update")
                        .param("project", projectId)
                        .query(Long.class)
                        .optional()
                        .orElseThrow(LocalSourceApprovalException::invalid);
                approvals.verifyBeforePublish(jobId, projectId);
                Long existing = jdbc.sql("select m.snapshot_id from source_manifests m join snapshots s "
                                + "on s.id=m.snapshot_id and s.project_id=m.project_id where m.job_id=:job "
                                + "and m.project_id=:project and m.sealed_at is not null "
                                + "and m.approval_manifest_sha256=:digest and s.commit_sha=:commit")
                        .param("job", jobId)
                        .param("project", projectId)
                        .param("digest", binding.manifestSha256())
                        .param("commit", commitOid)
                        .query(Long.class)
                        .optional()
                        .orElse(null);
                if (existing != null) return existing;
                long snapshot = jdbc.sql("insert into snapshots(project_id,commit_sha,status,source_contract_version) "
                                + "values (:project,:commit,'ANALYZING',1) returning id")
                        .param("project", projectId)
                        .param("commit", commitOid)
                        .query(Long.class)
                        .single();
                UUID manifest = UUID.randomUUID();
                jdbc.sql(
                                "insert into source_manifests(id,project_id,snapshot_id,job_id,contract_version,producer_version,"
                                        + "source_kind,approval_manifest_sha256,limits_sha256,policy_version,file_count,byte_size) "
                                        + "values (:id,:project,:snapshot,:job,1,'local-source-store-v1','LOCAL',:digest,:limits,:policy,:files,:bytes)")
                        .param("id", manifest)
                        .param("project", projectId)
                        .param("snapshot", snapshot)
                        .param("job", jobId)
                        .param("digest", binding.manifestSha256())
                        .param("limits", binding.limitsSha256())
                        .param("policy", binding.policyVersion())
                        .param("files", binding.selectedFiles())
                        .param("bytes", binding.selectedBytes())
                        .update();
                for (int offset = 0; offset < entries.size(); offset += 500) {
                    var batch = new org.springframework.jdbc.core.namedparam.SqlParameterSource
                            [Math.min(500, entries.size() - offset)];
                    for (int index = 0; index < batch.length; index++) {
                        Entry entry = entries.get(offset + index);
                        batch[index] = new org.springframework.jdbc.core.namedparam.MapSqlParameterSource()
                                .addValue("project", projectId)
                                .addValue("manifest", manifest)
                                .addValue("path", entry.path())
                                .addValue("oid", entry.gitOid())
                                .addValue("hash", entry.blob().sha256())
                                .addValue("size", entry.blob().byteSize())
                                .addValue("key", entry.blob().keyId());
                    }
                    batches.batchUpdate(
                            "insert into source_blobs(project_id,sha256,byte_size,key_id) "
                                    + "values (:project,:hash,:size,:key) on conflict do nothing",
                            batch);
                    int[] inserted = batches.batchUpdate(
                            "insert into source_manifest_entries(manifest_id,project_id,path,blob_sha256,git_oid,byte_size) "
                                    + "select :manifest,:project,:path,sha256,:oid,byte_size from source_blobs "
                                    + "where project_id=:project and sha256=:hash and byte_size=:size and key_id=:key",
                            batch);
                    for (int count : inserted) {
                        if (count != 1) throw new IllegalStateException("Retained source metadata is inconsistent.");
                    }
                }
                jdbc.sql("update source_manifests set sealed_at=clock_timestamp() where id=:id")
                        .param("id", manifest)
                        .update();
                jdbc.sql(
                                "insert into analysis_generations(id,project_id,snapshot_id,source_manifest_id,job_id,contract_version,"
                                        + "producer_version,status,previous_committed_generation_id) "
                                        + "select :id,id,:snapshot,:manifest,:job,1,'legacy-pipeline-source-v1','STAGING',current_generation_id "
                                        + "from projects where id=:project")
                        .param("id", UUID.randomUUID())
                        .param("project", projectId)
                        .param("snapshot", snapshot)
                        .param("manifest", manifest)
                        .param("job", jobId)
                        .update();
                // Keep the exclusion/count provenance in the same transaction as the immutable
                // input, so a retry can finish IMPORT without consulting the original folder.
                diagnostics.record(projectId, snapshot, summary);
                int attached = jdbc.sql(
                                "update analysis_jobs set snapshot_id=:snapshot where id=:job and project_id=:project and status='RUNNING'")
                        .param("snapshot", snapshot)
                        .param("job", jobId)
                        .param("project", projectId)
                        .update();
                if (attached != 1) throw LocalSourceApprovalException.invalid();
                return snapshot;
            }));
        }
    }

    private static MessageDigest sha256Digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private static boolean safePath(String path) {
        if (path == null
                || path.isBlank()
                || path.indexOf('\0') >= 0
                || path.indexOf('\\') >= 0
                || path.startsWith("/")
                || path.matches("^[A-Za-z]:.*")) return false;
        String lower = path.toLowerCase(java.util.Locale.ROOT);
        if (lower.contains("%2e") || lower.contains("%2f") || lower.contains("%5c")) return false;
        try {
            java.nio.file.Path relative = java.nio.file.Path.of(path);
            if (relative.isAbsolute() || !relative.normalize().toString().equals(path)) return false;
            for (java.nio.file.Path part : relative) {
                if (part.toString().equals("..") || part.toString().equalsIgnoreCase(".git")) return false;
            }
            return true;
        } catch (IllegalArgumentException error) {
            return false;
        }
    }
}
