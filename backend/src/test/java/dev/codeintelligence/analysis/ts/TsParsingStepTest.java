package dev.codeintelligence.analysis.ts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.analysis.graph.GraphPersistenceService;
import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.testsupport.TestJobContext;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;

class TsParsingStepTest {
    @TempDir
    Path root;

    private final TsAnalyzerClient client = mock(TsAnalyzerClient.class);
    private final GraphPersistenceService persistence = mock(GraphPersistenceService.class);
    private final List<Map<String, Object>> outcomes = new ArrayList<>();

    @Test
    void refreshCarriesOwnedCacheAndCompleteChangedContextAcrossJobsButNotProjects() throws Exception {
        var inventory = files(3, "export const value = 1;");
        var step = step(inventory);
        String cached = "{\"path\":\"0000.ts\",\"key\":\"" + "a".repeat(64) + "\",\"rows\":[]}";
        when(client.analyze(any()))
                .thenReturn(new TsAnalyzeDtos.Response(
                        null, null, null, null, null, null, null, null, null, null, null, null, null, List.of(cached)));
        step.run(new TestJobContext(1, 2, 3L, root));
        Files.writeString(root.resolve("0001.ts"), "export const value = 'changed';");
        step.run(new TestJobContext(2, 2, 3L, root));
        step.run(new TestJobContext(3, 9, 3L, root));
        var requests = ArgumentCaptor.forClass(TsAnalyzeDtos.Request.class);
        verify(client, times(3)).analyze(requests.capture());
        var sent = requests.getAllValues();
        assertThat(sent).allSatisfy(request -> assertThat(request.files()).hasSize(3));
        assertThat(sent.get(0).files().getFirst().cache()).isEmpty();
        assertThat(sent.get(1).files().getFirst().cache()).isEqualTo(cached);
        assertThat(sent.get(1).files().get(1).content()).contains("changed");
        assertThat(sent.get(2).files().getFirst().cache()).isEmpty();
    }

    @Test
    void acceptsExplicitTypeScriptModuleExtensionsEvenForOldUnclassifiedInventory() {
        for (String path : List.of("src/worker.mts", "src/worker.cts", "src/UPPER.MTS", "src/types.d.cts")) {
            assertThat(TsParsingStep.isAnalyzerInput(new InventoriedFile(path, null, 0, 1, "fixture")))
                    .as(path)
                    .isTrue();
        }
        assertThat(TsParsingStep.isAnalyzerInput(new InventoriedFile("src/worker.mts.bak", null, 0, 1, "fixture")))
                .isFalse();
    }

    @Test
    void sendsAll501FilesTogetherInsteadOfSplittingProjectContext() throws Exception {
        List<InventoriedFile> files = files(501, "export {};");
        step(files).run(new TestJobContext(1, 2, 3L, root));
        var request = ArgumentCaptor.forClass(TsAnalyzeDtos.Request.class);
        verify(client).analyze(request.capture());
        assertThat(request.getValue().files()).hasSize(501);
        assertThat(request.getValue().files().getFirst().path()).isEqualTo("0000.ts");
        assertThat(request.getValue().files().getLast().path()).isEqualTo("0500.ts");
        verify(persistence).persist(eq(2L), eq(3L), any());
        assertThat(outcomes).hasSize(1002);
        assertThat(outcomes.subList(501, 1002))
                .allSatisfy(outcome -> assertThat(outcome)
                        .containsEntry("sid", 3L)
                        .containsEntry("status", "UNMEASURED")
                        .containsEntry("reason", "ANALYZER_OUTCOME_MISSING_OR_INVALID"));
        assertThat(outcomes.subList(501, 1002))
                .extracting(outcome -> outcome.get("path"))
                .containsExactlyElementsOf(
                        files.stream().map(InventoriedFile::path).toList());
    }

    /**
     * The user's size-class decision (G-PERF R5/R6): a project over the 10 MiB single-request
     * budget is no longer refused. It travels as one sealed session whose chunks the analyzer
     * assembles into a single compiler project; result pages are merged in order.
     */
    @Test
    void sendsAProjectOverTheSingleRequestBudgetAsOneSealedSession() throws Exception {
        List<InventoriedFile> files = files(11, "x".repeat(1_000_000));
        TsParsingStep step = step(files);
        List<TsAnalyzeDtos.SessionCommand> commands = new ArrayList<>();
        String id = "0123456789abcdef0123456789abcdef";
        org.mockito.stubbing.Answer<TsAnalyzeDtos.Response> analyzer = invocation -> {
            TsAnalyzeDtos.Request request = invocation.getArgument(0);
            TsAnalyzeDtos.SessionCommand command = request.session();
            assertThat(request.files()).isEmpty();
            commands.add(command);
            return switch (command.op()) {
                case "analyze" -> page(id, "analyze", 0, "ts:0000.ts#First");
                case "page" -> page(id, "page", command.page(), "ts:0010.ts#Second");
                default -> reply(new TsAnalyzeDtos.SessionReply(id, command.op(), command.seq(), null, null));
            };
        };
        when(client.analyze(any())).thenAnswer(analyzer);
        // The sealed project's analyze command carries its own, size-scaled timeout.
        when(client.analyze(any(), any())).thenAnswer(analyzer);
        var persisted = ArgumentCaptor.forClass(dev.codeintelligence.analysis.core.AnalysisResult.class);

        step.run(new TestJobContext(1, 2, 3L, root));

        assertThat(commands)
                .extracting(TsAnalyzeDtos.SessionCommand::op)
                .containsExactly(
                        "open", "put", "put", "put", "put", "put", "put", "put", "put", "put", "put", "put", "seal",
                        "analyze", "page", "close");
        assertThat(commands)
                .filteredOn(command -> command.op().equals("put"))
                .allSatisfy(command -> assertThat(command.files()).hasSize(1))
                .extracting(TsAnalyzeDtos.SessionCommand::seq)
                .containsExactly(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
        TsProjectSession.ManifestBuilder expected = new TsProjectSession.ManifestBuilder();
        for (InventoriedFile file : files) expected.add(file.path(), "x".repeat(1_000_000));
        TsProjectSession.Manifest manifest = expected.build();
        for (TsAnalyzeDtos.SessionCommand command : List.of(commands.getFirst(), commands.get(12))) {
            assertThat(command.fileCount()).isEqualTo(11);
            assertThat(command.bytes()).isEqualTo(11_000_000L);
            assertThat(command.digest()).isEqualTo(manifest.digest());
        }
        verify(persistence).persist(eq(2L), eq(3L), persisted.capture());
        assertThat(persisted.getValue().nodes())
                .extracting(dev.codeintelligence.analysis.core.GraphNodeDraft::naturalKey)
                .contains("ts:0000.ts#First", "ts:0010.ts#Second");
        assertThat(outcomes.subList(11, 22))
                .noneSatisfy(outcome -> assertThat(outcome).containsEntry("reason", "PROJECT_REQUEST_LIMIT"));
    }

    @Test
    void sessionLimitIsTheLocalPreviewHardLimit() {
        TsProjectSession.requireWithinLimit(50_000, 512L * 1024 * 1024);
        assertThatThrownBy(() -> TsProjectSession.requireWithinLimit(50_001, 0))
                .isInstanceOf(TsAnalyzerException.class)
                .hasMessageContaining("50000-file / 512 MiB");
        assertThatThrownBy(() -> TsProjectSession.requireWithinLimit(1, 512L * 1024 * 1024 + 1))
                .isInstanceOf(TsAnalyzerException.class);
    }

    private static TsAnalyzeDtos.Response reply(TsAnalyzeDtos.SessionReply session) {
        return new TsAnalyzeDtos.Response(
                null, null, null, null, null, null, null, null, null, null, null, null, session);
    }

    private static TsAnalyzeDtos.Response page(String id, String op, int page, String key) {
        return new TsAnalyzeDtos.Response(
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                List.of(new TsAnalyzeDtos.SemanticNodeHit(key, "CLASS", key, null, 1, 1, null, Map.of())),
                null,
                null,
                null,
                new TsAnalyzeDtos.SessionReply(id, op, null, page, 2));
    }

    @SuppressWarnings("unchecked")
    private TsParsingStep step(List<InventoriedFile> files) {
        JdbcClient jdbc = mock(JdbcClient.class);
        JdbcClient.StatementSpec statement = mock(JdbcClient.StatementSpec.class);
        JdbcClient.MappedQuerySpec<InventoriedFile> query = mock(JdbcClient.MappedQuerySpec.class);
        when(jdbc.sql(anyString())).thenAnswer(invocation -> {
            String sql = invocation.getArgument(0);
            if (!sql.stripLeading().startsWith("update files")) return statement;
            JdbcClient.StatementSpec update = mock(JdbcClient.StatementSpec.class);
            Map<String, Object> parameters = new LinkedHashMap<>();
            when(update.param(anyString(), any())).thenAnswer(call -> {
                parameters.put(call.getArgument(0), call.getArgument(1));
                return update;
            });
            when(update.update()).thenAnswer(call -> {
                outcomes.add(Map.copyOf(parameters));
                return 1;
            });
            return update;
        });
        when(statement.param("snapshotId", 3L)).thenReturn(statement);
        when(statement.query(any(RowMapper.class))).thenReturn(query);
        when(query.list()).thenReturn(files);
        when(client.enabled()).thenReturn(true);
        when(client.timeout()).thenReturn(java.time.Duration.ofSeconds(30));
        when(client.analyze(any())).thenReturn(TsAnalyzeDtos.Response.EMPTY);
        return new TsParsingStep(
                client, jdbc, persistence, new AnalysisProperties(20_000, 1_048_576, 10_000, 5, 1_000, 0.5));
    }

    private List<InventoriedFile> files(int count, String content) throws Exception {
        List<InventoriedFile> result = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            String path = "%04d.ts".formatted(i);
            Files.writeString(root.resolve(path), content);
            result.add(new InventoriedFile(path, "typescript", Files.size(root.resolve(path)), 1, "fixture-hash"));
        }
        return result;
    }
}
