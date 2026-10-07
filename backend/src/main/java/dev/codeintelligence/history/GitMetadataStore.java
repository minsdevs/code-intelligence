package dev.codeintelligence.history;

import dev.codeintelligence.github.GithubPullSummary;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.core.namedparam.SqlParameterSource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

@Component
public class GitMetadataStore {

    /** Commit files per JDBC batch: the desktop's single snapshot commit adds every file. */
    private static final int BATCH = 500;

    private final JdbcClient jdbc;
    private final NamedParameterJdbcTemplate batches;
    private final TransactionTemplate transactionTemplate;

    public GitMetadataStore(
            JdbcClient jdbc, NamedParameterJdbcTemplate batches, TransactionTemplate transactionTemplate) {
        this.jdbc = jdbc;
        this.batches = batches;
        this.transactionTemplate = transactionTemplate;
    }

    public void replaceCloneMetadata(long projectId, GitMetadataScan scan) {
        transactionTemplate.executeWithoutResult(tx -> {
            for (ScannedCommit commit : scan.commits()) {
                long commitId = jdbc.sql("""
                                insert into commits (
                                    project_id, sha, author, message, committed_at, additions, deletions)
                                values (
                                    :projectId, :sha, :author, :message, :committedAt, :additions, :deletions)
                                on conflict (project_id, sha) do update set
                                    author = excluded.author,
                                    message = excluded.message,
                                    committed_at = excluded.committed_at,
                                    additions = excluded.additions,
                                    deletions = excluded.deletions
                                returning id
                                """)
                        .param("projectId", projectId)
                        .param("sha", commit.sha())
                        .param("author", commit.author())
                        .param("message", commit.message())
                        .param("committedAt", toOffset(commit.committedAt()))
                        .param("additions", commit.additions())
                        .param("deletions", commit.deletions())
                        .query(Long.class)
                        .single();
                jdbc.sql("delete from commit_files where commit_id = :commitId")
                        .param("commitId", commitId)
                        .update();
                List<ScannedCommitFile> files = commit.files();
                for (int start = 0; start < files.size(); start += BATCH) {
                    batches.batchUpdate(
                            """
                                    insert into commit_files (commit_id, path, change_type)
                                    values (:commitId, :path, :changeType)
                                    """,
                            files.subList(start, Math.min(start + BATCH, files.size())).stream()
                                    .map(file -> new MapSqlParameterSource()
                                            .addValue("commitId", commitId)
                                            .addValue("path", file.path())
                                            .addValue("changeType", file.changeType()))
                                    .toArray(SqlParameterSource[]::new));
                }
            }
            jdbc.sql("delete from branches where project_id = :projectId")
                    .param("projectId", projectId)
                    .update();
            for (ScannedRef branch : scan.branches()) {
                jdbc.sql("""
                                insert into branches (project_id, name, head_sha)
                                values (:projectId, :name, :headSha)
                                """)
                        .param("projectId", projectId)
                        .param("name", branch.name())
                        .param("headSha", branch.headSha())
                        .update();
            }
            jdbc.sql("delete from tags where project_id = :projectId")
                    .param("projectId", projectId)
                    .update();
            for (ScannedRef tag : scan.tags()) {
                jdbc.sql("""
                                insert into tags (project_id, name, head_sha)
                                values (:projectId, :name, :headSha)
                                """)
                        .param("projectId", projectId)
                        .param("name", tag.name())
                        .param("headSha", tag.headSha())
                        .update();
            }
        });
    }

    public Optional<String> findPullsEtag(long projectId) {
        return jdbc.sql("select pulls_etag from projects where id = :projectId")
                .param("projectId", projectId)
                .query(String.class)
                .optional();
    }

    public void savePullsEtag(long projectId, String etag) {
        jdbc.sql("update projects set pulls_etag = :etag, updated_at = now() where id = :projectId")
                .param("etag", etag)
                .param("projectId", projectId)
                .update();
    }

    public void upsertPulls(long projectId, List<GithubPullSummary> pulls) {
        transactionTemplate.executeWithoutResult(tx -> {
            for (GithubPullSummary pull : pulls) {
                jdbc.sql("""
                                insert into pull_requests (
                                    project_id, number, title, body, state, author, merged_at, head_sha, base_sha)
                                values (
                                    :projectId, :number, :title, :body, :state, :author, :mergedAt, :headSha, :baseSha)
                                on conflict (project_id, number) do update set
                                    title = excluded.title,
                                    body = excluded.body,
                                    state = excluded.state,
                                    author = excluded.author,
                                    merged_at = excluded.merged_at,
                                    head_sha = excluded.head_sha,
                                    base_sha = excluded.base_sha
                                """)
                        .param("projectId", projectId)
                        .param("number", pull.number())
                        .param("title", pull.title())
                        .param("body", pull.body())
                        .param("state", pull.state())
                        .param("author", pull.author())
                        .param("mergedAt", toOffset(pull.mergedAt()))
                        .param("headSha", pull.headSha())
                        .param("baseSha", pull.baseSha())
                        .update();
            }
        });
    }

    private static OffsetDateTime toOffset(Instant value) {
        return value == null ? null : value.atOffset(ZoneOffset.UTC);
    }
}
