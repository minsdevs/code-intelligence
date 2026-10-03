package dev.codeintelligence.project;

import dev.codeintelligence.common.AppProperties;
import dev.codeintelligence.job.JobRecord;
import dev.codeintelligence.job.JobWorkspaceProvider;
import dev.codeintelligence.source.SourceStoreClient;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/** Selects a run-owned source directory without giving the job framework access to project internals. */
@Component
public class SourceJobWorkspace implements JobWorkspaceProvider {
    private final AppProperties app;
    private final SourceStoreClient client;
    private final RetainedRunWorkspace scratch;
    private final JdbcClient jdbc;

    public SourceJobWorkspace(
            AppProperties app, SourceStoreClient client, RetainedRunWorkspace scratch, JdbcClient jdbc) {
        this.app = app;
        this.client = client;
        this.scratch = scratch;
        this.jdbc = jdbc;
    }

    @Override
    public Workspace open(JobRecord job) {
        Input input = jdbc.sql("select p.source_type,s.source_contract_version from analysis_jobs j "
                        + "join projects p on p.id=j.project_id left join snapshots s on s.id=j.snapshot_id and s.project_id=p.id "
                        + "where j.id=:job and j.project_id=:project and j.status='RUNNING'")
                .param("job", job.id())
                .param("project", job.projectId())
                .query((rs, row) ->
                        new Input(rs.getString("source_type"), rs.getObject("source_contract_version", Integer.class)))
                .optional()
                .orElseThrow(SourceJobWorkspace::invalid);
        if (job.snapshotId() != null && input.version() == null) throw invalid();
        boolean retained = Integer.valueOf(1).equals(input.version());
        boolean initialCapture = job.snapshotId() == null && "LOCAL".equals(input.kind()) && client.enabled();
        if (!retained && !initialCapture)
            return JobWorkspaceProvider.unmanaged(app.reposRoot().resolve(Long.toString(job.projectId())));
        if (!client.enabled() || !"LOCAL".equals(input.kind())) throw invalid();
        var lease = scratch.create(job.projectId(), job.id());
        try {
            if (retained) {
                RetainedRunWorkspace.Manifest manifest = manifest(job.projectId(), job.id(), job.snapshotId());
                scratch.reconstruct(lease, manifest, (hash, size) -> client.read(job.projectId(), hash, size));
            }
            return new Workspace() {
                @Override
                public java.nio.file.Path clonePath() {
                    return lease.clonePath();
                }

                @Override
                public void close() {
                    lease.close();
                }
            };
        } catch (RuntimeException error) {
            try {
                lease.close();
            } catch (RuntimeException cleanup) {
                error.addSuppressed(cleanup);
            }
            throw error;
        }
    }

    @Override
    public boolean verifyRetainedCheckpoint(long projectId, long jobId, long snapshotId) {
        Input input = jdbc.sql("select p.source_type,s.source_contract_version from analysis_jobs j "
                        + "join projects p on p.id=j.project_id join snapshots s on s.id=j.snapshot_id and s.project_id=p.id "
                        + "where j.id=:job and j.project_id=:project and j.snapshot_id=:snapshot "
                        + "and j.status in ('RUNNING','FAILED')")
                .param("job", jobId)
                .param("project", projectId)
                .param("snapshot", snapshotId)
                .query((rs, row) -> new Input(rs.getString("source_type"), rs.getInt("source_contract_version")))
                .optional()
                .orElseThrow(SourceJobWorkspace::invalid);
        if (Integer.valueOf(0).equals(input.version())) return false;
        if (!Integer.valueOf(1).equals(input.version()) || !client.enabled() || !"LOCAL".equals(input.kind()))
            throw invalid();
        manifest(projectId, jobId, snapshotId);
        return true;
    }

    private RetainedRunWorkspace.Manifest manifest(long projectId, long jobId, long snapshotId) {
        Header header = jdbc.sql(
                        "select m.id,s.commit_sha,i.approved_at,m.policy_version,m.limits_sha256,"
                                + "m.approval_manifest_sha256,m.file_count,m.byte_size from source_manifests m "
                                + "join snapshots s on s.id=m.snapshot_id and s.project_id=m.project_id "
                                + "join analysis_generations g on g.source_manifest_id=m.id and g.snapshot_id=s.id and g.project_id=m.project_id "
                                + "join job_local_source_inputs i on i.job_id=m.job_id and i.project_id=m.project_id "
                                + "join projects p on p.id=m.project_id "
                                + "where m.project_id=:project and m.snapshot_id=:snapshot and m.job_id=:job and g.job_id=:job "
                                + "and m.sealed_at is not null and m.contract_version=1 and g.contract_version=1 "
                                + "and m.producer_version='local-source-store-v1' and g.producer_version='legacy-pipeline-source-v1' "
                                + "and g.status='STAGING' and m.source_kind='LOCAL' "
                                + "and g.previous_committed_generation_id is not distinct from p.current_generation_id "
                                + "and m.approval_manifest_sha256=i.manifest_sha256 "
                                + "and m.limits_sha256=i.limits_sha256 and m.policy_version=i.policy_version "
                                + "and m.file_count=i.selected_files and m.byte_size=i.selected_bytes "
                                + "and exists(select 1 from evidence_links l join evidences e on e.id=l.evidence_id "
                                + "where l.subject_type='LOCAL_IMPORT' and l.subject_id=m.snapshot_id and e.project_id=m.project_id)")
                .param("project", projectId)
                .param("snapshot", snapshotId)
                .param("job", jobId)
                .query((rs, row) -> new Header(
                        rs.getObject("id", UUID.class),
                        rs.getString("commit_sha"),
                        rs.getObject("approved_at", OffsetDateTime.class).toInstant(),
                        rs.getString("policy_version"),
                        rs.getString("limits_sha256"),
                        rs.getString("approval_manifest_sha256"),
                        rs.getInt("file_count"),
                        rs.getLong("byte_size")))
                .optional()
                .orElseThrow(SourceJobWorkspace::invalid);
        long metadataBytes = jdbc.sql("select coalesce(sum(octet_length(path)+168),0) from source_manifest_entries "
                        + "where manifest_id=:id and project_id=:project")
                .param("id", header.id())
                .param("project", projectId)
                .query(Long.class)
                .single();
        if (metadataBytes > 16L * 1024 * 1024) throw invalid();
        List<RetainedRunWorkspace.Entry> entries = jdbc.sql("select e.path,e.git_oid,e.blob_sha256,e.byte_size "
                        + "from source_manifest_entries e join source_blobs b on b.project_id=e.project_id "
                        + "and b.sha256=e.blob_sha256 and b.byte_size=e.byte_size "
                        + "where e.manifest_id=:id and e.project_id=:project order by e.path collate \"C\" limit 50001")
                .param("id", header.id())
                .param("project", projectId)
                .query((rs, row) -> new RetainedRunWorkspace.Entry(
                        rs.getString("path"),
                        rs.getString("git_oid"),
                        rs.getString("blob_sha256"),
                        rs.getLong("byte_size")))
                .list();
        return new RetainedRunWorkspace.Manifest(
                header.commit(),
                header.approvedAt(),
                header.policy(),
                header.limits(),
                header.digest(),
                header.files(),
                header.bytes(),
                entries);
    }

    private record Input(String kind, Integer version) {}

    private record Header(
            UUID id,
            String commit,
            java.time.Instant approvedAt,
            String policy,
            String limits,
            String digest,
            int files,
            long bytes) {}

    private static IllegalStateException invalid() {
        return new IllegalStateException("The retained input for this analysis is unavailable.");
    }
}
