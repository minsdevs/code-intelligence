package dev.codeintelligence.ai;

import java.util.List;
import java.util.Locale;
import java.util.Optional;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class SummaryService {

    private final JdbcClient jdbc;
    private final AIProviderResolver providerResolver;
    private final AiUsageService usage;
    private final TransactionTemplate transactions;

    public SummaryService(
            JdbcClient jdbc,
            AIProviderResolver providerResolver,
            AiUsageService usage,
            TransactionTemplate transactions) {
        this.jdbc = jdbc;
        this.providerResolver = providerResolver;
        this.usage = usage;
        this.transactions = transactions;
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
        AIProvider provider = providerResolver.resolve(userId);
        if (existing != null) {
            if (provider.enabled()) {
                String embeddingModel = embeddingModel(provider);
                if (!embeddingModel.equals(existing.embeddingModel())) {
                    float[] embedding = provider.embed(existing.content());
                    transactions.execute(status -> jdbc.sql("""
                                    update summaries
                                    set embedding = :embedding::vector, embedding_model = :embeddingModel
                                    where snapshot_id = :snapshotId
                                      and subject_type = 'FILE'
                                      and subject_id = :fileId
                                      and level = 'FILE'
                                    """)
                            .param("embedding", toVectorLiteral(embedding))
                            .param("embeddingModel", embeddingModel)
                            .param("snapshotId", snapshotId)
                            .param("fileId", file.id())
                            .update());
                }
            }
            return Optional.of(existing.content());
        }
        if (!provider.enabled() || source == null || source.isBlank()) {
            return Optional.empty();
        }
        AIProvider.ChatResponse response = usage.chat(
                userId,
                file.projectId(),
                provider,
                "summary",
                new AIProvider.ChatRequest(
                        PromptBuilder.SYSTEM,
                        "Summarize this file in at most two sentences. JSON claims may be empty.\n"
                                + trim(source, 4000),
                        true));
        String content = response.explanation().isBlank() ? response.raw() : response.explanation();
        if (content.isBlank()) {
            return Optional.empty();
        }
        float[] embedding = provider.embed(content);
        transactions.execute(status -> jdbc.sql("""
                        insert into summaries (snapshot_id, subject_type, subject_id, level, content, embedding, model, embedding_model, token_count, content_hash)
                        values (:snapshotId, 'FILE', :fileId, 'FILE', :content, :embedding::vector, :model, :embeddingModel, :tokens, :hash)
                        on conflict (snapshot_id, subject_type, subject_id, level)
                        do update set content = excluded.content, embedding = excluded.embedding,
                                      model = excluded.model, embedding_model = excluded.embedding_model,
                                      token_count = excluded.token_count,
                                      content_hash = excluded.content_hash
                        """)
                .param("snapshotId", snapshotId)
                .param("fileId", file.id())
                .param("content", trim(content, 2000))
                .param("embedding", toVectorLiteral(embedding))
                .param("model", provider.model())
                .param("embeddingModel", embeddingModel(provider))
                .param("tokens", response.promptTokens() + response.completionTokens())
                .param("hash", file.hash())
                .update());
        return Optional.of(trim(content, 2000));
    }

    public List<String> similar(long userId, long snapshotId, String query, int limit) {
        AIProvider provider = providerResolver.resolve(userId);
        if (!provider.enabled() || query == null || query.isBlank()) {
            return List.of();
        }
        float[] embedding = provider.embed(query);
        return jdbc.sql("""
                        select content from summaries
                        where snapshot_id = :snapshotId
                          and embedding is not null
                          and embedding_model = :embeddingModel
                        order by embedding <=> :query::vector
                        limit :limit
                        """)
                .param("snapshotId", snapshotId)
                .param("embeddingModel", embeddingModel(provider))
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

    private static String embeddingModel(AIProvider provider) {
        return provider.name() + ":" + provider.embeddingModel();
    }

    private static String trim(String text, int max) {
        if (text.length() <= max) {
            return text;
        }
        return text.substring(0, max);
    }

    private record FileRow(long id, String hash, long projectId) {}

    private record SummaryRow(String content, String embeddingModel) {}
}
