package dev.codeintelligence.auth;

import dev.codeintelligence.common.security.CredentialKind;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/** Immutable reads and committed ciphertext-revision CAS; never upserts during refresh. */
@Component
public class GithubCredentialStore {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;

    public GithubCredentialStore(JdbcTemplate jdbc, PlatformTransactionManager transactionManager) {
        this.jdbc = jdbc;
        transactions = new TransactionTemplate(transactionManager);
        transactions.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    public Optional<StoredCredential> find(long userId) {
        return transactions.execute(status -> jdbc
                .query(
                        """
                        select c.id,c.user_id,c.kind,c.key_version,c.nonce,c.encrypted_token,c.expires_at,u.github_id
                        from github_credentials c join users u on u.id=c.user_id
                        where c.user_id=? and c.kind in ('OAUTH','PAT')
                        order by case c.kind when 'OAUTH' then 0 else 1 end limit 1
                        """,
                        (row, index) -> new StoredCredential(
                                row.getLong("id"),
                                row.getLong("user_id"),
                                CredentialKind.valueOf(row.getString("kind")),
                                row.getInt("key_version"),
                                row.getBytes("nonce"),
                                row.getString("encrypted_token"),
                                row.getTimestamp("expires_at") == null
                                        ? null
                                        : row.getTimestamp("expires_at").toInstant(),
                                row.getObject("github_id", Long.class)),
                        userId)
                .stream()
                .findFirst());
    }

    /** Commit before returning/unlocking. An uncertain commit does not permit another provider POST. */
    public boolean compareAndSet(StoredCredential expected, EncryptedToken replacement, Instant expiresAt) {
        return Boolean.TRUE.equals(transactions.execute(status -> jdbc.update(
                        """
                        update github_credentials set encrypted_token=?,nonce=?,key_version=?,expires_at=?,updated_at=now()
                        where id=? and user_id=? and kind=? and key_version=? and nonce=? and encrypted_token=?
                        and expires_at is not distinct from ?
                        and exists(select 1 from users u where u.id=github_credentials.user_id
                          and u.github_id is not distinct from ?)
                        """,
                        replacement.ciphertext(),
                        replacement.nonce(),
                        replacement.keyVersion(),
                        timestamp(expiresAt),
                        expected.id(),
                        expected.userId(),
                        expected.kind().name(),
                        expected.keyVersion(),
                        expected.nonce(),
                        expected.ciphertext(),
                        timestamp(expected.expiresAt()),
                        expected.githubId())
                == 1));
    }

    private static Timestamp timestamp(Instant value) {
        return value == null ? null : Timestamp.from(value);
    }

    public record StoredCredential(
            long id,
            long userId,
            CredentialKind kind,
            int keyVersion,
            byte[] nonce,
            String ciphertext,
            Instant expiresAt,
            Long githubId) {
        public StoredCredential {
            nonce = nonce.clone();
        }

        @Override
        public byte[] nonce() {
            return nonce.clone();
        }

        public StoredCredential replaced(EncryptedToken value, Instant expiry) {
            return new StoredCredential(
                    id, userId, kind, value.keyVersion(), value.nonce(), value.ciphertext(), expiry, githubId);
        }

        public EncryptedToken encrypted() {
            return new EncryptedToken(keyVersion, nonce(), ciphertext);
        }

        @Override
        public String toString() {
            return "StoredGithubCredential{id=" + id + ",userId=" + userId + ",material=REDACTED}";
        }
    }
}
