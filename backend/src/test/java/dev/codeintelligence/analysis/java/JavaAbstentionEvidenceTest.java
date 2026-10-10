package dev.codeintelligence.analysis.java;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphEdgeDraft;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.InventoriedFile;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** G-ACCURACY D3 (abstentions), D7 (inheritance clause spans) and D8 (inherited stubs without span claims). */
class JavaAbstentionEvidenceTest {

    @TempDir
    Path temp;

    private static final String CALLS = """
            package demo;
            interface Action { void run(); }
            class FirstAction implements Action { public void run() {} }
            class SecondAction implements Action { public void run() {} }
            class Calls {
              static int twice(int value) { return value * 2; }
              static int direct() { return twice(2); }
              static void indirect(Action action) { action.run(); }
              static void dynamic(String name) throws Exception { Class.forName(name); }
            }
            """;

    private static final String REPOSITORY = """
            package demo.repository;

            import demo.domain.Todo;
            import org.springframework.data.jpa.repository.JpaRepository;

            public interface TodoRepository extends JpaRepository<Todo, Long> {}
            """;

    private static final String SERVICE = """
            package demo.service;

            import demo.domain.Todo;
            import demo.repository.TodoRepository;

            public class TodoService {
              private final TodoRepository repository;
              public TodoService(TodoRepository repository) { this.repository = repository; }
              public Todo findById(long id) { return repository.findById(id).orElseThrow(); }
            }
            """;

    private static final String TODO = """
            package demo.domain;

            public class Todo { public long id; }
            """;

    private AnalysisResult analyze(Map<String, String> files) throws Exception {
        Path repo = temp.resolve("repo");
        for (var entry : files.entrySet()) {
            Path file = repo.resolve(entry.getKey());
            Files.createDirectories(file.getParent());
            Files.writeString(file, entry.getValue());
        }
        List<InventoriedFile> inventory = files.keySet().stream()
                .sorted()
                .map(path -> new InventoriedFile(path, "java", 0, 1, ""))
                .toList();
        return new JavaAnalyzer().analyze(new AnalysisContext(1, 1, repo, FileInventory.of(inventory)));
    }

    private static GraphNodeDraft node(AnalysisResult result, String key) {
        return result.nodes().stream()
                .filter(node -> node.naturalKey().equals(key))
                .findFirst()
                .orElseThrow(() -> new AssertionError("missing node " + key));
    }

    @Test
    void callWithoutAnyProjectTargetIsPublishedAsAnExternalTargetAbstentionWithCallSiteLines() throws Exception {
        AnalysisResult result = analyze(Map.of("src/main/java/demo/Calls.java", CALLS));
        GraphNodeDraft dynamic = node(result, "java:demo.Calls#dynamic(java.lang.String)");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> abstentions =
                (List<Map<String, Object>>) dynamic.metadata().get("unresolvedCalls");
        assertThat(abstentions).hasSize(1);
        assertThat(abstentions.getFirst())
                .containsEntry("expression", "Class.forName")
                .containsEntry("lineStart", 9)
                .containsEntry("lineEnd", 9)
                .containsEntry("reason", "EXTERNAL_TARGET");
        // Nothing is falsely resolved: no CALLS edge leaves the dynamic method.
        assertThat(result.edges())
                .filteredOn(edge -> edge.edgeType().equals("CALLS")
                        && edge.sourceNaturalKey().equals(dynamic.naturalKey()))
                .isEmpty();
        // Resolved project calls keep their edge and publish no abstention.
        GraphNodeDraft direct = node(result, "java:demo.Calls#direct()");
        assertThat(direct.metadata()).doesNotContainKey("unresolvedCalls");
        assertThat(result.edges())
                .filteredOn(edge -> edge.edgeType().equals("CALLS")
                        && edge.sourceNaturalKey().equals(direct.naturalKey()))
                .hasSize(1);
        // The file stays PARTIAL/UNRESOLVED_CALLS: an abstention is not a success claim.
        assertThat(result.fileOutcomes())
                .singleElement()
                .matches(outcome ->
                        outcome.status().equals("PARTIAL") && outcome.reason().equals("UNRESOLVED_CALLS"));
    }

    @Test
    void frameworkAndLibraryCallsAbstainWhileInheritedStubsCarryNoFileAssociation() throws Exception {
        AnalysisResult result = analyze(Map.of(
                "src/main/java/demo/repository/TodoRepository.java", REPOSITORY,
                "src/main/java/demo/service/TodoService.java", SERVICE,
                "src/main/java/demo/domain/Todo.java", TODO));
        GraphNodeDraft findById = node(result, "java:demo.service.TodoService#findById(long)");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> abstentions =
                (List<Map<String, Object>>) findById.metadata().get("unresolvedCalls");
        assertThat(abstentions)
                .extracting(entry -> entry.get("expression"), entry -> entry.get("reason"))
                .containsExactly(
                        org.assertj.core.groups.Tuple.tuple("repository.findById(id).orElseThrow", "EXTERNAL_TARGET"));
        // D8: repository.findById is inherited from JpaRepository; the stub has no file and explicit provenance.
        GraphNodeDraft stub = node(result, "java:demo.repository.TodoRepository#findById(long)");
        assertThat(stub.filePath()).isNull();
        assertThat(stub.lineStart()).isNull();
        assertThat(stub.metadata()).containsEntry("inherited", true).containsEntry("provenance", "INHERITED");
        assertThat(result.edges())
                .filteredOn(edge -> edge.edgeType().equals("CALLS")
                        && edge.targetNaturalKey().equals(stub.naturalKey()))
                .singleElement()
                .matches(edge -> edge.confidence().equals("POSSIBLE"));
    }

    @Test
    void inheritanceEdgesPublishTheClauseLinesAndTheSupertypeAsWritten() throws Exception {
        AnalysisResult result = analyze(Map.of(
                "src/main/java/demo/repository/TodoRepository.java", REPOSITORY,
                "src/main/java/demo/domain/Todo.java", TODO));
        GraphEdgeDraft extendsEdge = result.edges().stream()
                .filter(edge -> edge.edgeType().equals("EXTENDS")
                        && edge.sourceNaturalKey().equals("java:demo.repository.TodoRepository"))
                .findFirst()
                .orElseThrow();
        assertThat(extendsEdge.metadata())
                .containsEntry("clause", "extends")
                .containsEntry("lineStart", 6)
                .containsEntry("lineEnd", 6)
                .containsEntry("expression", "JpaRepository<Todo, Long>")
                .containsEntry("filePath", "src/main/java/demo/repository/TodoRepository.java");
        AnalysisResult calls = analyze(Map.of("src/main/java/demo/Calls.java", CALLS));
        assertThat(calls.edges())
                .filteredOn(edge -> edge.edgeType().equals("IMPLEMENTS"))
                .allSatisfy(edge -> assertThat(edge.metadata())
                        .containsEntry("clause", "implements")
                        .containsEntry("expression", "Action"));
    }
}
