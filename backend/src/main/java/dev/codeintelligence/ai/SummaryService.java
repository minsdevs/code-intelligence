package dev.codeintelligence.ai;

import java.util.List;
import java.util.Locale;
import java.util.Optional;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

@Service
public class SummaryService {

    private final JdbcClient jdbc;

    public SummaryService(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public Optional<String> ensureFileSummary(long userId, long snapshotId, String path, String source) {
        FileRow file = jdbc.sql("""
                        select f.id, f.content_hash, s.project_id from files f
                        join snapshots s on s.id = f.snapshot_id
                        where f.snapshot_id = :snapshotId and f.path = :path
                        """)
                .param("snapshotId", snapshotId)
                .param("path", path)
                .query((rs, rowNum) ->
                        new FileRow(rs.getLong("id"), rs.getString("content_hash"), rs.getLong("project_id")))
                .optional()
                .orElse(null);
        if (file == null) {
            return Optional.empty();
        }
        SummaryRow existing = jdbc.sql("""
                        select content, embedding_model from summaries
                        where snapshot_id = :snapshotId
                          and subject_type = 'FILE'
                          and subject_id = :fileId
                          and level = 'FILE'
                          and (content_hash is null or content_hash = :hash)
                        """)
                .param("snapshotId", snapshotId)
                .param("fileId", file.id())
                .param("hash", file.hash())
                .query((rs, rowNum) -> new SummaryRow(rs.getString("content"), rs.getString("embedding_model")))
                .optional()
                .orElse(null);
        // Reuse retained summaries only. Background retrieval never authorizes a paid request.
        return existing == null ? Optional.empty() : Optional.of(existing.content());
    }

    public List<String> similar(long userId, long snapshotId, String query, int limit) {
        // Embeddings need a separate exact request approval; lexical search remains available.
        return List.of();
    }

    static String toVectorLiteral(float[] values) {
        StringBuilder out = new StringBuilder("[");
        int n = Math.min(1536, values.length);
        for (int i = 0; i < 1536; i++) {
            if (i > 0) {
                out.append(',');
            }
            float v = i < n ? values[i] : 0f;
            out.append(String.format(Locale.ROOT, "%.6f", v));
        }
        out.append(']');
        return out.toString();
    }

    private record FileRow(long id, String hash, long projectId) {}

    private record SummaryRow(String content, String embeddingModel) {}
}
