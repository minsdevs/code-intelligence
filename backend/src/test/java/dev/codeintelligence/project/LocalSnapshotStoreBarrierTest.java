package dev.codeintelligence.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.RETURNS_DEEP_STUBS;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import dev.codeintelligence.source.SourceStoreClient;
import dev.codeintelligence.source.SourceStoreException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.List;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectInserter;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.support.TransactionCallback;
import org.springframework.transaction.support.TransactionTemplate;

/** Source metadata may name only blobs that the vault acknowledged durable through one barrier. */
class LocalSnapshotStoreBarrierTest {
    private static final long PROJECT = 7;
    private static final long JOB = 11;
    private static final String SESSION = "c".repeat(32);
    private static final String KEY = "b".repeat(32);
    private static final String COMMIT = "1".repeat(40);
    private static final List<String> PATHS = List.of("a.txt", "b.txt");

    private final SourceStoreClient client = mock(SourceStoreClient.class);
    private final TransactionTemplate transactions = mock(TransactionTemplate.class);
    private final LocalSourceApprovalService approvals = mock(LocalSourceApprovalService.class);
    private LocalSnapshotStore store;
    private LocalSourceBinding binding;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() throws Exception {
        JdbcClient jdbc = mock(JdbcClient.class, RETURNS_DEEP_STUBS);
        when(jdbc.sql(anyString())
                        .param(anyString(), any())
                        .param(anyString(), any())
                        .query(any(RowMapper.class))
                        .single())
                .thenReturn(Instant.parse("2026-10-07T00:00:00Z"));
        var manifest = new LocalSourceManifest("policy-v1", "d".repeat(64));
        long bytes = 0;
        for (String path : PATHS) {
            byte[] content = content(path);
            manifest.add(
                    path, content.length, MessageDigest.getInstance("SHA-256").digest(content));
            bytes += content.length;
        }
        binding = new LocalSourceBinding(
                1, "/fixture", "posix", "id", "owner", "policy-v1", "d".repeat(64), manifest.finish(), 2, bytes);
        when(client.enabled()).thenReturn(true);
        when(approvals.requireJobInput(JOB, PROJECT)).thenReturn(binding);
        when(transactions.execute(any())).thenReturn(42L);
        store = new LocalSnapshotStore(
                client,
                jdbc,
                mock(org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate.class),
                transactions,
                approvals,
                mock(LocalImportDiagnostics.class));
    }

    @Test
    void publicationWaitsForOneBarrierCoveringEveryStagedBlob() {
        stageAll(SESSION, SESSION);
        var capture = capture();
        assertThat(capture.publish(COMMIT, null)).isEqualTo(42L);
        var order = inOrder(client, transactions);
        order.verify(client).stage(PROJECT, content("a.txt"));
        order.verify(client).stage(PROJECT, content("b.txt"));
        order.verify(client).barrier(SESSION, 2);
        order.verify(transactions).execute(any(TransactionCallback.class));
        verify(client, never()).put(anyLong(), any());
    }

    @Test
    void aFailedBarrierCommitsNoSourceMetadata() {
        stageAll(SESSION, SESSION);
        doThrow(SourceStoreException.unavailable()).when(client).barrier(SESSION, 2);
        var capture = capture();
        assertThatThrownBy(() -> capture.publish(COMMIT, null)).isInstanceOf(SourceStoreException.class);
        verify(transactions, never()).execute(any());
    }

    @Test
    void aVaultSessionChangeDuringCaptureFailsBeforeAnyBarrierOrMetadata() {
        stageAll(SESSION, "e".repeat(32));
        var capture = store.begin(PROJECT, JOB, binding);
        capture.accept("a.txt", oid(content("a.txt")), content("a.txt"));
        assertThatThrownBy(() -> capture.accept("b.txt", oid(content("b.txt")), content("b.txt")))
                .isInstanceOf(SourceStoreException.class);
        verify(client, never()).barrier(anyString(), anyLong());
        verify(transactions, never()).execute(any());
    }

    private void stageAll(String first, String second) {
        when(client.stage(PROJECT, content("a.txt"))).thenReturn(staged("a.txt", first, 1));
        when(client.stage(PROJECT, content("b.txt"))).thenReturn(staged("b.txt", second, 2));
    }

    private LocalSnapshotStore.Capture capture() {
        var capture = store.begin(PROJECT, JOB, binding);
        for (String path : PATHS) capture.accept(path, oid(content(path)), content(path));
        return capture;
    }

    private static SourceStoreClient.StagedBlob staged(String path, String session, long sequence) {
        byte[] content = content(path);
        try {
            String hash = java.util.HexFormat.of()
                    .formatHex(MessageDigest.getInstance("SHA-256").digest(content));
            return new SourceStoreClient.StagedBlob(hash, content.length, KEY, session, sequence);
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }

    private static byte[] content(String path) {
        return ("content of " + path + "\n").getBytes(StandardCharsets.UTF_8);
    }

    private static String oid(byte[] bytes) {
        try (var formatter = new ObjectInserter.Formatter()) {
            return formatter.idFor(Constants.OBJ_BLOB, bytes).name();
        }
    }
}
