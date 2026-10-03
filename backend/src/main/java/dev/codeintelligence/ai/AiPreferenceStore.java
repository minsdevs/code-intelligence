package dev.codeintelligence.ai;

import java.util.Optional;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** Keyless user preferences. Mutations run inside the caller's control transaction. */
@Repository
public class AiPreferenceStore {
    public record Preference(String provider, String model, String state, long revision) {}

    record ActiveCredential(
            String provider, String model, long revision, int keyVersion, byte[] nonce, String encryptedKey) {
        @Override
        public String toString() {
            return "ActiveCredential[redacted]";
        }
    }

    private final JdbcClient jdbc;

    public AiPreferenceStore(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    Optional<Preference> find(long userId) {
        return jdbc.sql(
                        "select provider, model, connection_state, revision from user_ai_preferences where user_id=:user")
                .param("user", userId)
                .query((rs, row) -> new Preference(
                        rs.getString("provider"),
                        rs.getString("model"),
                        rs.getString("connection_state"),
                        rs.getLong("revision")))
                .optional();
    }

    Optional<ActiveCredential> activeCredential(long userId) {
        // One SQL snapshot ties revision to the exact credential instead of mixing separate reads.
        return jdbc.sql("""
                select p.provider, p.model, p.revision, s.key_version, s.nonce, s.encrypted_key
                from user_ai_preferences p join user_ai_settings s on s.user_id=p.user_id
                where p.user_id=:user and p.connection_state='ENABLED'
                  and p.provider=s.provider and p.model is not distinct from s.model
                """)
                .param("user", userId)
                .query((rs, row) -> new ActiveCredential(
                        rs.getString("provider"),
                        rs.getString("model"),
                        rs.getLong("revision"),
                        rs.getInt("key_version"),
                        rs.getBytes("nonce"),
                        rs.getString("encrypted_key")))
                .optional();
    }

    long beginSave(long userId) {
        return jdbc.sql("""
                insert into user_ai_preferences (user_id, revision) values (:user, 1)
                on conflict (user_id) do update
                set revision=user_ai_preferences.revision+1, updated_at=now()
                returning revision
                """).param("user", userId).query(Long.class).single();
    }

    boolean enable(long userId, long expectedRevision, String provider, String model) {
        return jdbc.sql("""
                update user_ai_preferences
                set provider=:provider, model=:model, connection_state='ENABLED',
                    revision=revision+1, updated_at=now()
                where user_id=:user and revision=:revision
                """)
                        .param("user", userId)
                        .param("revision", expectedRevision)
                        .param("provider", provider)
                        .param("model", model)
                        .update()
                == 1;
    }

    void disable(long userId) {
        jdbc.sql("""
                insert into user_ai_preferences (user_id, connection_state, revision) values (:user, 'OFF', 1)
                on conflict (user_id) do update
                set connection_state='OFF', revision=user_ai_preferences.revision+1, updated_at=now()
                """).param("user", userId).update();
    }

    boolean revisionMatches(long userId, long revision, boolean requireEnabled) {
        return jdbc.sql("""
                select exists(select 1 from user_ai_preferences p
                where p.user_id=:user and p.revision=:revision
                  and (not :enabled or (p.connection_state='ENABLED' and exists(
                    select 1 from user_ai_settings s where s.user_id=p.user_id
                    and s.provider=p.provider and s.model is not distinct from p.model))))
                """)
                .param("user", userId)
                .param("revision", revision)
                .param("enabled", requireEnabled)
                .query(Boolean.class)
                .single();
    }
}
