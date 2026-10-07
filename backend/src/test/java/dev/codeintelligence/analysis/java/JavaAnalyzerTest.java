package dev.codeintelligence.analysis.java;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphEdgeDraft;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.analysis.core.NaturalKeys;
import dev.codeintelligence.common.LanguageDetector;
import dev.codeintelligence.testsupport.FixtureRepo;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class JavaAnalyzerTest {

    @TempDir
    Path temp;

    @Test
    void duplicateFqcnInSeparateModulesDoesNotProduceCallsToAnArbitraryModule() throws Exception {
        Path repo = java.nio.file.Files.createTempDirectory("java-identity-");
        try {
            String one = "one/src/main/java/demo/Service.java";
            String two = "two/src/main/java/demo/Service.java";
            for (String path : java.util.List.of(one, two)) {
                java.nio.file.Files.createDirectories(repo.resolve(path).getParent());
                java.nio.file.Files.writeString(
                        repo.resolve(path),
                        "package demo; public class Service { public void run() { helper(); } void helper() {} }");
            }
            var result = new JavaAnalyzer()
                    .analyze(new dev.codeintelligence.analysis.core.AnalysisContext(
                            1,
                            1,
                            repo,
                            dev.codeintelligence.analysis.core.FileInventory.of(java.util.List.of(
                                    new dev.codeintelligence.analysis.core.InventoriedFile(one, "java", 0, 1, ""),
                                    new dev.codeintelligence.analysis.core.InventoriedFile(two, "java", 0, 1, "")))));
            assertThat(result.edges()).noneMatch(edge -> edge.edgeType().equals("CALLS"));
            assertThat(result.nodes())
                    .filteredOn(node -> node.naturalKey().equals("java:demo.Service"))
                    .singleElement()
                    .matches(node -> node.nodeType().equals("AMBIGUOUS") && node.filePath() == null);
            assertThat(result.fileOutcomes())
                    .allMatch(outcome -> outcome.status().equals("PARTIAL")
                            && outcome.reason().equals("AMBIGUOUS_SYMBOL_IDENTITY"));
        } finally {
            try (var paths = java.nio.file.Files.walk(repo)) {
                for (Path path :
                        paths.sorted(java.util.Comparator.reverseOrder()).toList()) java.nio.file.Files.delete(path);
            }
        }
    }

    @Test
    void springMiniCallsControllerToServiceConfirmedAndRepositoryPossible() throws Exception {
        Path clone = FixtureRepo.create("spring-mini", temp.resolve("repo"));
        FileInventory inventory = inventory(clone);
        AnalysisResult result = new JavaAnalyzer().analyze(new AnalysisContext(1, 1, clone, inventory));

        Set<String> classes = keys(result, "CLASS");
        assertThat(classes)
                .containsExactlyInAnyOrder(
                        "java:com.example.todo.TodoApplication",
                        "java:com.example.todo.TodoServiceTest",
                        "java:com.example.todo.api.AuthController",
                        "java:com.example.todo.api.TodoController",
                        "java:com.example.todo.domain.Todo",
                        "java:com.example.todo.service.AuthService",
                        "java:com.example.todo.service.TodoService");
        assertThat(keys(result, "INTERFACE")).contains("java:com.example.todo.repository.TodoRepository");
        assertThat(keys(result, "METHOD")).hasSize(24);

        Set<String> confirmedCalls = callKeys(result, "CONFIRMED");
        Set<String> possibleCalls = callKeys(result, "POSSIBLE");
        assertThat(confirmedCalls).hasSize(5);
        assertThat(possibleCalls).hasSize(3);
        assertThat(confirmedCalls)
                .contains(
                        call(
                                "com.example.todo.api.TodoController",
                                "list",
                                List.of(),
                                "com.example.todo.service.TodoService",
                                "findAll",
                                List.of()),
                        call(
                                "com.example.todo.api.TodoController",
                                "get",
                                List.of("java.lang.Long"),
                                "com.example.todo.service.TodoService",
                                "findById",
                                List.of("java.lang.Long")),
                        call(
                                "com.example.todo.api.TodoController",
                                "create",
                                List.of("com.example.todo.domain.Todo"),
                                "com.example.todo.service.TodoService",
                                "create",
                                List.of("com.example.todo.domain.Todo")),
                        call(
                                "com.example.todo.api.AuthController",
                                "login",
                                List.of(),
                                "com.example.todo.service.AuthService",
                                "login",
                                List.of()),
                        call(
                                "com.example.todo.api.AuthController",
                                "logout",
                                List.of(),
                                "com.example.todo.service.AuthService",
                                "logout",
                                List.of()));
        assertThat(possibleCalls)
                .contains(
                        call(
                                "com.example.todo.service.TodoService",
                                "findAll",
                                List.of(),
                                "com.example.todo.repository.TodoRepository",
                                "findAll",
                                List.of()),
                        call(
                                "com.example.todo.service.TodoService",
                                "findById",
                                List.of("java.lang.Long"),
                                "com.example.todo.repository.TodoRepository",
                                "findById",
                                List.of("java.lang.Long")),
                        call(
                                "com.example.todo.service.TodoService",
                                "create",
                                List.of("com.example.todo.domain.Todo"),
                                "com.example.todo.repository.TodoRepository",
                                "save",
                                List.of("com.example.todo.domain.Todo")));
        assertThat(result.fileOutcomes())
                .anyMatch(outcome ->
                        outcome.status().equals("PARTIAL") && outcome.reason().equals("UNRESOLVED_CALLS"));
        assertThat(result.fileOutcomes()).anyMatch(outcome -> outcome.status().equals("SUCCESS"));
        assertThat(extendsEdges(result))
                .contains("java:com.example.todo.repository.TodoRepository"
                        + "->java:org.springframework.data.jpa.repository.JpaRepository");
    }

    @Test
    void interfaceAndAbstractReceiverCallsAreInferredImplementationCandidates() throws Exception {
        AnalysisResult result = analyzeCalls();
        String action = NaturalKeys.javaMethod("demo.Action", "run", List.of());
        String first = NaturalKeys.javaMethod("demo.FirstAction", "run", List.of());
        String second = NaturalKeys.javaMethod("demo.SecondAction", "run", List.of());
        String third = NaturalKeys.javaMethod("demo.ThirdAction", "run", List.of());
        String indirect = NaturalKeys.javaMethod("demo.Calls", "indirect", List.of("demo.Action"));
        assertThat(callEdges(result, indirect))
                .extracting(GraphEdgeDraft::targetNaturalKey)
                .containsExactlyInAnyOrder(first, second, third);
        assertThat(callEdges(result, indirect)).allSatisfy(edge -> {
            assertThat(edge.confidence()).isEqualTo("POSSIBLE");
            assertThat(edge.metadata())
                    .containsEntry("resolution", "inferred")
                    .containsEntry("declaredTarget", action)
                    .containsEntry("targetCandidates", List.of(first, second, third));
        });

        String square = NaturalKeys.javaMethod("demo.Square", "area", List.of());
        String circle = NaturalKeys.javaMethod("demo.Circle", "area", List.of());
        String shape = NaturalKeys.javaMethod("demo.Calls", "shape", List.of("demo.Shape"));
        assertThat(callEdges(result, shape))
                .allMatch(edge -> edge.confidence().equals("POSSIBLE"))
                .extracting(GraphEdgeDraft::targetNaturalKey)
                .containsExactlyInAnyOrder(square, circle);
        String implicitThis = NaturalKeys.javaMethod("demo.Shape", "twice", List.of());
        assertThat(callEdges(result, implicitThis))
                .allMatch(edge -> edge.confidence().equals("POSSIBLE"))
                .extracting(GraphEdgeDraft::targetNaturalKey)
                .containsExactlyInAnyOrder(square, circle);

        assertThat(callEdges(result, NaturalKeys.javaMethod("demo.Calls", "concrete", List.of("demo.FirstAction"))))
                .singleElement()
                .matches(edge -> edge.confidence().equals("CONFIRMED")
                        && edge.targetNaturalKey().equals(first));
        assertThat(callEdges(result, NaturalKeys.javaMethod("demo.Calls", "exact", List.of("demo.Circle"))))
                .singleElement()
                .matches(edge -> edge.confidence().equals("CONFIRMED")
                        && edge.targetNaturalKey().equals(circle));
        assertThat(result.edges())
                .noneMatch(edge -> edge.edgeType().equals("CALLS")
                        && edge.confidence().equals("CONFIRMED")
                        && (edge.targetNaturalKey().equals(action)
                                || edge.targetNaturalKey()
                                        .equals(NaturalKeys.javaMethod("demo.Shape", "area", List.of()))));
    }

    @Test
    void javaCallEdgesCarryTheirCallSite() throws Exception {
        AnalysisResult result = analyzeCalls();
        assertThat(callEdges(result, NaturalKeys.javaMethod("demo.Calls", "direct", List.of())))
                .singleElement()
                .satisfies(edge -> assertThat(edge.metadata())
                        .containsEntry("filePath", "Calls.java")
                        .containsEntry("lineStart", 11)
                        .containsEntry("lineEnd", 11)
                        .containsEntry("expression", "twice"));
        assertThat(callEdges(result, NaturalKeys.javaMethod("demo.Calls", "indirect", List.of("demo.Action"))))
                .hasSize(3)
                .allSatisfy(edge -> assertThat(edge.metadata())
                        .containsEntry("lineStart", 12)
                        .containsEntry("expression", "action.run"));
        assertThat(callEdges(result, NaturalKeys.javaMethod("demo.Calls", "chained", List.of("demo.Square"))))
                .singleElement()
                .satisfies(edge -> assertThat(edge.metadata())
                        .containsEntry("lineStart", 16)
                        .containsEntry("lineEnd", 17)
                        .containsEntry("expression", "square\n      .area"));
    }

    private AnalysisResult analyzeCalls() throws Exception {
        Path repo = Files.createDirectories(temp.resolve("calls"));
        Files.writeString(repo.resolve("Calls.java"), """
                package demo;
                interface Action { void run(); }
                class FirstAction implements Action { public void run() {} }
                class SecondAction implements Action { public void run() {} }
                record ThirdAction() implements Action { public void run() {} }
                abstract class Shape { abstract double area(); double twice() { return area() * 2; } }
                class Square extends Shape { double area() { return 1; } }
                final class Circle extends Shape { double area() { return 3; } }
                class Calls {
                  static int twice(int value) { return value * 2; }
                  static int direct() { return twice(2); }
                  static void indirect(Action action) { action.run(); }
                  static void concrete(FirstAction first) { first.run(); }
                  static double shape(Shape shape) { return shape.area(); }
                  static double exact(Circle circle) { return circle.area(); }
                  static double chained(Square square) { return square
                      .area(); }
                }
                """);
        return new JavaAnalyzer()
                .analyze(new AnalysisContext(
                        1, 1, repo, FileInventory.of(new InventoriedFile("Calls.java", "java", 0, 18, ""))));
    }

    private static List<GraphEdgeDraft> callEdges(AnalysisResult result, String caller) {
        return result.edges().stream()
                .filter(edge -> "CALLS".equals(edge.edgeType()) && caller.equals(edge.sourceNaturalKey()))
                .toList();
    }

    @Test
    void syntaxErrorFileIsIsolated() throws Exception {
        Path clone = FixtureRepo.create("spring-mini", temp.resolve("broken"));
        Path broken = clone.resolve("src/main/java/com/example/todo/Broken.java");
        Files.writeString(broken, "package com.example.todo;\npublic class Broken { this is not java\n");
        FileInventory inventory = inventory(clone);
        AnalysisResult result = new JavaAnalyzer().analyze(new AnalysisContext(1, 1, clone, inventory));
        assertThat(keys(result, "CLASS")).contains("java:com.example.todo.api.TodoController");
        assertThat(keys(result, "CLASS")).doesNotContain("java:com.example.todo.Broken");
        assertThat(result.fileOutcomes())
                .anyMatch(outcome -> outcome.path().endsWith("Broken.java")
                        && outcome.status().equals("FAILED"));
        assertThat(result.fileOutcomes())
                .filteredOn(outcome -> outcome.path().endsWith("Broken.java"))
                .hasSize(1);
        assertThat(result.evidences())
                .anyMatch(evidence -> evidence.subjectNaturalKey() == null
                        && evidence.filePath().endsWith("Broken.java"));
    }

    private static FileInventory inventory(Path clone) throws Exception {
        try (Stream<Path> walk = Files.walk(clone)) {
            List<InventoriedFile> files = walk.filter(Files::isRegularFile)
                    .filter(path -> !path.toString().contains("/.git/"))
                    .map(path -> {
                        String rel = clone.relativize(path).toString().replace('\\', '/');
                        return new InventoriedFile(rel, LanguageDetector.detect(rel), 0, 0, "");
                    })
                    .toList();
            return FileInventory.of(files);
        }
    }

    private static Set<String> keys(AnalysisResult result, String nodeType) {
        return result.nodes().stream()
                .filter(node -> nodeType.equals(node.nodeType()))
                .map(GraphNodeDraft::naturalKey)
                .collect(Collectors.toSet());
    }

    private static Set<String> callKeys(AnalysisResult result, String confidence) {
        return result.edges().stream()
                .filter(edge -> "CALLS".equals(edge.edgeType()) && confidence.equals(edge.confidence()))
                .map(edge -> edge.sourceNaturalKey() + "->" + edge.targetNaturalKey())
                .collect(Collectors.toSet());
    }

    private static Set<String> extendsEdges(AnalysisResult result) {
        return result.edges().stream()
                .filter(edge -> "EXTENDS".equals(edge.edgeType()))
                .map(edge -> edge.sourceNaturalKey() + "->" + edge.targetNaturalKey())
                .collect(Collectors.toSet());
    }

    private static String call(
            String fromType,
            String fromMethod,
            List<String> fromParams,
            String toType,
            String toMethod,
            List<String> toParams) {
        return NaturalKeys.javaMethod(fromType, fromMethod, fromParams) + "->"
                + NaturalKeys.javaMethod(toType, toMethod, toParams);
    }
}
