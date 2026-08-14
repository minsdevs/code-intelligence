package dev.codeintelligence.ai;

import java.util.List;
import java.util.Locale;
import java.util.Optional;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class SummaryService {

    private final JdbcClient jdbc;
    private final AIProvider aiProvider;

    public SummaryService(JdbcClient jdbc, AIProvider aiProvider) {
        this.jdbc = jdbc;
        this.aiProvider = aiProvider;
    }

    @Transactional
    public Optional<String> ensureFileSummary(long snapshotId, String path, String source) {
        FileRow file = jdbc.sql("""
                        select id, content_hash from files
                        where snapshot_id = :snapshotId and path = :path
                        """)
                .param("snapshotId", snapshotId)
                .param("path", path)
                .query((rs, rowNum) -> new FileRow(rs.getLong("id"), rs.getString("content_hash")))
                .optional()
                .orElse(null);
        if (file == null) {
            return Optional.empty();
        }
        Optional<String> existing = jdbc.sql("""
                        select content from summaries
                        where snapshot_id = :snapshotId
                          and subject_type = 'FILE'
                          and subject_id = :fileId
                          and level = 'FILE'
                          and (content_hash is null or content_hash = :hash)
                        """)
                .param("snapshotId", snapshotId)
                .param("fileId", file.id())
                .param("hash", file.hash())
                .query(String.class)
                .optional();
        if (existing.isPresent()) {
            return existing;
        }
        if (!aiProvider.enabled() || source == null || source.isBlank()) {
            return Optional.empty();
        }
        AIProvider.ChatResponse response = aiProvider.chat(new AIProvider.ChatRequest(
                PromptBuilder.SYSTEM,
                "Summarize this file in at most two sentences. JSON claims may be empty.\n" + trim(source, 4000),
                true));
        String content = response.explanation().isBlank() ? response.raw() : response.explanation();
        if (content.isBlank()) {
            return Optional.empty();
        }
        float[] embedding = aiProvider.embed(content);
        jdbc.sql("""
                        insert into summaries (snapshot_id, subject_type, subject_id, level, content, embedding, model, token_count, content_hash)
                        values (:snapshotId, 'FILE', :fileId, 'FILE', :content, :embedding::vector, :model, :tokens, :hash)
                        on conflict (snapshot_id, subject_type, subject_id, level)
                        do update set content = excluded.content, embedding = excluded.embedding,
                                      model = excluded.model, token_count = excluded.token_count,
                                      content_hash = excluded.content_hash
                        """)
                .param("snapshotId", snapshotId)
                .param("fileId", file.id())
                .param("content", trim(content, 2000))
                .param("embedding", toVectorLiteral(embedding))
                .param("model", aiProvider.name())
                .param("tokens", response.promptTokens() + response.completionTokens())
                .param("hash", file.hash())
                .update();
        return Optional.of(trim(content, 2000));
    }

    public List<String> similar(long snapshotId, String query, int limit) {
        if (!aiProvider.enabled() || query == null || query.isBlank()) {
            return List.of();
        }
        float[] embedding = aiProvider.embed(query);
        return jdbc.sql("""
                        select content from summaries
                        where snapshot_id = :snapshotId and embedding is not null
                        order by embedding <=> :query::vector
                        limit :limit
                        """)
                .param("snapshotId", snapshotId)
                .param("query", toVectorLiteral(embedding))
                .param("limit", limit)
                .query(String.class)
                .list();
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

    private static String trim(String text, int max) {
        if (text.length() <= max) {
            return text;
        }
        return text.substring(0, max);
    }

    private record FileRow(long id, String hash) {}
}
