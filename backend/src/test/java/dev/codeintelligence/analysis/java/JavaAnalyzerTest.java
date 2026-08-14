package dev.codeintelligence.analysis.java;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.analysis.core.LanguageDetector;
import dev.codeintelligence.analysis.core.NaturalKeys;
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
        assertThat(extendsEdges(result))
                .contains("java:com.example.todo.repository.TodoRepository"
                        + "->java:org.springframework.data.jpa.repository.JpaRepository");
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
