package dev.codeintelligence.auth;

import static org.assertj.core.api.Assertions.*;

import dev.codeintelligence.auth.GithubCredentialStore.StoredCredential;
import dev.codeintelligence.common.security.CredentialKind;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Properties;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

/** Opt-in new fixture only, actual V1-V27 migrations and independent committed JDBC transactions. */
@EnabledIfEnvironmentVariable(named = "CI_GITHUB_STORE_REAL", matches = "1")
@Timeout(60)
class GithubCredentialStorePostgresTest {
    private static DriverManagerDataSource dataSource;
    private static JdbcTemplate jdbc;
    private static DataSourceTransactionManager manager;
    private static final long USER = 700001L;
    private static final Instant EXPIRY = Instant.parse("2026-10-05T02:00:00Z");
    private static final GithubDeviceCredentialCodec codec =
            new GithubDeviceCredentialCodec(new TokenCryptoProperties("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="));
    private GithubCredentialStore store;

    @BeforeAll
    static void setupDatabase() throws Exception {
        String root = System.getenv("CI_AUTH_FIXTURE_ROOT"), url = System.getenv("CI_AUTH_JDBC_URL");
        assertThat(root).isNotBlank();
        Path directory = Path.of(root).toRealPath();
        assertThat(directory.getFileName().toString()).startsWith("auth-store-");
        assertThat(Files.readString(directory.resolve("purpose.txt"))).isEqualTo("isolated-github-credential-store\n");
        assertThat(url).matches("jdbc:postgresql://127\\.0\\.0\\.1:[0-9]+/ci_auth_store_[a-f0-9]{16}\\?.+");
        Properties properties = new Properties();
        properties.setProperty("user", "codeintel");
        properties.setProperty("password", System.getenv("CI_AUTH_DB_PASSWORD"));
        properties.setProperty("sslcert", directory.resolve("absent-client.crt").toString());
        properties.setProperty("sslkey", directory.resolve("absent-client.key").toString());
        dataSource = new DriverManagerDataSource();
        dataSource.setUrl(url);
        dataSource.setConnectionProperties(properties);
        jdbc = new JdbcTemplate(dataSource);
        manager = new DataSourceTransactionManager(dataSource);
        Flyway.configure()
                .dataSource(dataSource)
                .locations("classpath:db/migration")
                .load()
                .migrate();
        assertThat(jdbc.queryForObject(
                        "select count(*) from flyway_schema_history where success and type='SQL'", Long.class))
                .isEqualTo(27L);
    }

    @BeforeEach
    void seedCredential() {
        // The runner creates a database whose name is a fresh random fixture id.
        jdbc.update("delete from github_credentials where user_id=?", USER);
        jdbc.update("delete from users where id=?", USER);
        jdbc.update(
                "insert into users(id,github_id,login,local_key,identity_type) values(?,42,'synthetic','auth-store-fixture','LOCAL_LINKED')",
                USER);
        var encrypted = active();
        jdbc.update(
                "insert into github_credentials(user_id,kind,encrypted_token,nonce,key_version,expires_at) values(?,'OAUTH',?,?,2,?)",
                USER,
                encrypted.ciphertext(),
                encrypted.nonce(),
                java.sql.Timestamp.from(EXPIRY));
        store = new GithubCredentialStore(jdbc, manager);
    }

    private static EncryptedToken active() {
        return codec.encrypt(
                USER,
                GithubDeviceCredentialCodec.Envelope.active(
                        "fixture-client",
                        42,
                        "synthetic-access",
                        EXPIRY,
                        "synthetic-refresh",
                        EXPIRY.plusSeconds(86400)));
    }

    private static EncryptedToken pending() {
        return codec.encrypt(
                USER,
                GithubDeviceCredentialCodec.Envelope.active(
                                "fixture-client",
                                42,
                                "synthetic-access",
                                EXPIRY,
                                "synthetic-refresh",
                                EXPIRY.plusSeconds(86400))
                        .pending(UUID.randomUUID().toString()));
    }

    @Test
    void claimIsCommittedBeforeReturningAndSurvivesAnOuterRollback() {
        StoredCredential original = store.find(USER).orElseThrow();
        var claimed = pending();
        new TransactionTemplate(manager).executeWithoutResult(outer -> {
            assertThat(store.compareAndSet(original, claimed, EXPIRY)).isTrue();
            var independent = new GithubCredentialStore(
                    new JdbcTemplate(dataSource), new DataSourceTransactionManager(dataSource));
            assertThat(independent.find(USER).orElseThrow().ciphertext()).isEqualTo(claimed.ciphertext());
            outer.setRollbackOnly();
        });
        var after = store.find(USER).orElseThrow();
        assertThat(after.ciphertext()).isEqualTo(claimed.ciphertext());
        assertThat(codec.decrypt(USER, after.kind(), after.keyVersion(), after.nonce(), after.ciphertext())
                        .state())
                .isEqualTo(GithubDeviceCredentialCodec.State.REFRESH_PENDING);
    }

    @Test
    void staleCiphertextNonceExpiryAndOwnerIdentityNeverReplaceARevision() {
        StoredCredential original = store.find(USER).orElseThrow();
        assertThat(store.compareAndSet(original, active(), EXPIRY)).isTrue();
        assertThat(store.compareAndSet(original, pending(), EXPIRY)).isFalse();
        StoredCredential current = store.find(USER).orElseThrow();
        assertThat(store.compareAndSet(
                        new StoredCredential(
                                current.id(),
                                USER,
                                CredentialKind.PAT,
                                current.keyVersion(),
                                current.nonce(),
                                current.ciphertext(),
                                current.expiresAt(),
                                current.githubId()),
                        pending(),
                        EXPIRY))
                .isFalse();
        assertThat(store.compareAndSet(
                        new StoredCredential(
                                current.id(),
                                USER,
                                current.kind(),
                                current.keyVersion(),
                                current.nonce(),
                                current.ciphertext(),
                                EXPIRY.minusSeconds(1),
                                current.githubId()),
                        pending(),
                        EXPIRY))
                .isFalse();
        jdbc.update("update users set github_id=99 where id=?", USER);
        assertThat(store.compareAndSet(current, pending(), EXPIRY)).isFalse();
    }

    @Test
    void concurrentIndependentClaimsHaveExactlyOneWinner() throws Exception {
        StoredCredential original = store.find(USER).orElseThrow();
        var barrier = new CyclicBarrier(2);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var first = pool.submit(() -> {
                barrier.await(3, TimeUnit.SECONDS);
                return store.compareAndSet(original, pending(), EXPIRY);
            });
            var other = new GithubCredentialStore(
                    new JdbcTemplate(dataSource), new DataSourceTransactionManager(dataSource));
            var second = pool.submit(() -> {
                barrier.await(3, TimeUnit.SECONDS);
                return other.compareAndSet(original, pending(), EXPIRY);
            });
            assertThat(first.get(5, TimeUnit.SECONDS)).isNotEqualTo(second.get(5, TimeUnit.SECONDS));
        }
    }

    @Test
    void disconnectCannotBeUndoneByLateRefreshPublication() {
        StoredCredential original = store.find(USER).orElseThrow();
        var claimed = pending();
        assertThat(store.compareAndSet(original, claimed, EXPIRY)).isTrue();
        StoredCredential expected = store.find(USER).orElseThrow();
        jdbc.update("delete from github_credentials where user_id=?", USER);
        assertThat(store.compareAndSet(expected, active(), EXPIRY.plusSeconds(1)))
                .isFalse();
        assertThat(store.find(USER)).isEmpty();
    }

    @Test
    void oauthPreferenceAndNullPatExpiryArePreservedWithoutImplicitFallback() {
        var pat = new TokenCryptoService(new TokenCryptoProperties("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="))
                .encrypt("synthetic-pat");
        jdbc.update(
                "insert into github_credentials(user_id,kind,encrypted_token,nonce,key_version) values(?,'PAT',?,?,1)",
                USER,
                pat.ciphertext(),
                pat.nonce());
        assertThat(store.find(USER).orElseThrow().kind()).isEqualTo(CredentialKind.OAUTH);
        jdbc.update("delete from github_credentials where user_id=? and kind='OAUTH'", USER);
        var row = store.find(USER).orElseThrow();
        assertThat(row.expiresAt()).isNull();
        assertThat(store.compareAndSet(row, pat, Instant.EPOCH)).isTrue();
        assertThat(store.find(USER).orElseThrow().expiresAt()).isEqualTo(Instant.EPOCH);
    }

    @Test
    void returnedNonceIsDefensiveAndCannotChangeCasAuthority() {
        StoredCredential row = store.find(USER).orElseThrow();
        byte[] nonce = row.nonce();
        nonce[0] ^= 1;
        assertThat(row.nonce()).isNotEqualTo(nonce);
        assertThat(store.compareAndSet(row, pending(), EXPIRY)).isTrue();
    }
}
