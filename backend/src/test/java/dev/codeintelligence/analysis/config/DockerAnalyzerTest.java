package dev.codeintelligence.analysis.config;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.analysis.core.NaturalKeys;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class DockerAnalyzerTest {

    @TempDir
    Path temp;

    private final DockerAnalyzer analyzer = new DockerAnalyzer();

    @Test
    void composeDependsOnCreatesDeployedInFromDependentToDependency() throws Exception {
        Path repo = temp.resolve("compose");
        Files.createDirectories(repo);
        Files.writeString(repo.resolve("docker-compose.yml"), """
                services:
                  postgres:
                    image: postgres:16
                  backend:
                    build: ./backend
                    depends_on:
                      - postgres
                  frontend:
                    build: ./frontend
                """);
        AnalysisResult result = analyzer.analyze(new AnalysisContext(
                1, 1, repo, FileInventory.of(new InventoriedFile("docker-compose.yml", "yaml", 0, 0, ""))));
        assertThat(keys(result, "CONTAINER"))
                .containsExactlyInAnyOrder(
                        NaturalKeys.container("postgres"),
                        NaturalKeys.container("backend"),
                        NaturalKeys.container("frontend"));
        assertThat(deployedIn(result))
                .containsExactly(NaturalKeys.container("backend") + "->" + NaturalKeys.container("postgres"));
    }

    @Test
    void mapStyleDependsOnAndDockerfileEvidence() throws Exception {
        Path repo = temp.resolve("infra");
        Files.createDirectories(repo);
        Files.writeString(repo.resolve("Dockerfile"), """
                FROM eclipse-temurin:21-jdk AS build
                FROM eclipse-temurin:21-jre
                EXPOSE 8080
                CMD ["java", "-jar", "/app/app.jar"]
                """);
        Files.writeString(repo.resolve("docker-compose.yml"), """
                services:
                  app:
                    build: .
                    depends_on:
                      postgres:
                        condition: service_started
                  postgres:
                    image: postgres:16
                """);
        AnalysisResult result = analyzer.analyze(new AnalysisContext(
                1,
                1,
                repo,
                FileInventory.of(List.of(
                        new InventoriedFile("docker-compose.yml", "yaml", 0, 0, ""),
                        new InventoriedFile("Dockerfile", "dockerfile", 0, 0, "")))));
        assertThat(keys(result, "CONTAINER"))
                .containsExactlyInAnyOrder(NaturalKeys.container("app"), NaturalKeys.container("postgres"));
        assertThat(deployedIn(result))
                .containsExactly(NaturalKeys.container("app") + "->" + NaturalKeys.container("postgres"));
        assertThat(result.evidences())
                .anyMatch(evidence -> NaturalKeys.container("app").equals(evidence.subjectNaturalKey())
                        && "Dockerfile".equals(evidence.filePath()));
        GraphNodeDraft app = result.nodes().stream()
                .filter(node -> NaturalKeys.container("app").equals(node.naturalKey()))
                .findFirst()
                .orElseThrow();
        assertThat(app.metadata().get("dockerfile")).isEqualTo("Dockerfile");
        @SuppressWarnings("unchecked")
        List<String> fromImages = (List<String>) app.metadata().get("from");
        assertThat(fromImages).contains("eclipse-temurin:21-jdk", "eclipse-temurin:21-jre");
    }

    private static Set<String> keys(AnalysisResult result, String type) {
        return result.nodes().stream()
                .filter(node -> type.equals(node.nodeType()))
                .map(GraphNodeDraft::naturalKey)
                .collect(Collectors.toSet());
    }

    @ParameterizedTest
    @ValueSource(strings = {"../outside", "missing", "https://example.invalid/repo.git", "${CONTEXT}", "~/outside"})
    void unresolvedBuildContextsNeverBorrowAnotherDockerfile(String context) throws Exception {
        Path repo = temp.resolve("repo");
        Files.createDirectories(repo);
        Path outside = temp.resolve("outside");
        Files.createDirectories(outside);
        Files.writeString(outside.resolve("Dockerfile"), "FROM private-sentinel\n");
        Files.writeString(repo.resolve("Dockerfile"), "FROM unrelated-root\n");
        Files.writeString(repo.resolve("compose.yaml"), "services:\n  app:\n    build: '" + context + "'\n");
        AnalysisResult result = analyze(repo, "compose.yaml", "Dockerfile");
        assertThat(container(result).metadata()).doesNotContainKey("dockerfile");
        assertThat(result.evidences()).allMatch(e -> "compose.yaml".equals(e.filePath()));
    }

    @Test
    void absoluteOrUninventoriedDockerfilesCannotBecomeEvidence() throws Exception {
        Path repo = temp.resolve("repo");
        Files.createDirectories(repo);
        Path outside = temp.resolve("outside.Dockerfile");
        Files.writeString(outside, "FROM private-sentinel\n");
        Files.writeString(repo.resolve("unlisted"), "FROM unlisted\n");
        for (String dockerfile : List.of(outside.toString(), "unlisted")) {
            Files.writeString(
                    repo.resolve("compose.yaml"),
                    "services:\n  app:\n    build:\n      context: .\n      dockerfile: '" + dockerfile + "'\n");
            AnalysisResult result = analyze(repo, "compose.yaml");
            assertThat(container(result).metadata()).doesNotContainKey("dockerfile");
            assertThat(result.evidences()).allMatch(e -> "compose.yaml".equals(e.filePath()));
        }
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "false",
                "123",
                "[]",
                "{context: false}",
                "{dockerfile: 123}",
                "{context: []}",
                "{dockerfile: {}}"
            })
    void invalidBuildTypesNeverBorrowAnInventoriedDockerfile(String build) throws Exception {
        Path repo = temp.resolve("repo");
        Files.createDirectories(repo);
        Files.writeString(repo.resolve("Dockerfile"), "FROM unrelated-root\n");
        Files.writeString(repo.resolve("123"), "FROM unrelated-numeric\n");
        Files.createDirectories(repo.resolve("false"));
        Files.writeString(repo.resolve("false/Dockerfile"), "FROM unrelated-boolean\n");
        Files.writeString(repo.resolve("compose.yaml"), "services:\n  app:\n    build: " + build + "\n");
        AnalysisResult result = analyze(repo, "compose.yaml", "Dockerfile", "123", "false/Dockerfile");
        assertThat(container(result).metadata()).doesNotContainKey("dockerfile");
        assertThat(result.evidences()).allMatch(e -> "compose.yaml".equals(e.filePath()));
    }

    @Test
    void relativeCustomDockerfileResolvesFromContextWithinInventory() throws Exception {
        Path repo = temp.resolve("repo");
        Files.createDirectories(repo.resolve("deploy/service"));
        Files.writeString(repo.resolve("deploy/recipe"), "FROM alpine:3\nEXPOSE 8080\n");
        Files.writeString(repo.resolve("deploy/compose.yaml"), """
                services:
                  app:
                    build:
                      context: service
                      dockerfile: ../recipe
                """);
        AnalysisResult result = analyze(repo, "deploy/compose.yaml", "deploy/recipe");
        assertThat(container(result).metadata()).containsEntry("dockerfile", "deploy/recipe");
        assertThat(result.evidences()).anyMatch(e -> "deploy/recipe".equals(e.filePath()));
    }

    @Test
    void inlineDockerfileDoesNotBorrowAnInventoriedFile() throws Exception {
        Path repo = temp.resolve("repo");
        Files.createDirectories(repo);
        Files.writeString(repo.resolve("Dockerfile"), "FROM unrelated\n");
        Files.writeString(repo.resolve("compose.yaml"), """
                services:
                  app:
                    build:
                      context: .
                      dockerfile_inline: FROM alpine
                """);
        assertThat(container(analyze(repo, "compose.yaml", "Dockerfile")).metadata())
                .doesNotContainKey("dockerfile");
    }

    private AnalysisResult analyze(Path repo, String... paths) {
        return analyzer.analyze(new AnalysisContext(
                1,
                1,
                repo,
                FileInventory.of(java.util.Arrays.stream(paths)
                        .map(path -> new InventoriedFile(path, "text", 0, 0, ""))
                        .toList())));
    }

    private static GraphNodeDraft container(AnalysisResult result) {
        return result.nodes().stream()
                .filter(node -> NaturalKeys.container("app").equals(node.naturalKey()))
                .findFirst()
                .orElseThrow();
    }

    private static Set<String> deployedIn(AnalysisResult result) {
        return result.edges().stream()
                .filter(edge -> "DEPLOYED_IN".equals(edge.edgeType()))
                .map(edge -> edge.sourceNaturalKey() + "->" + edge.targetNaturalKey())
                .collect(Collectors.toSet());
    }
}
