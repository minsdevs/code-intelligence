ALTER TABLE summaries ADD COLUMN embedding_model text;

CREATE INDEX idx_summaries_embedding_model
    ON summaries (snapshot_id, embedding_model)
    WHERE embedding IS NOT NULL;
