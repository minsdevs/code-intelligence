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

    private static Set<String> deployedIn(AnalysisResult result) {
        return result.edges().stream()
                .filter(edge -> "DEPLOYED_IN".equals(edge.edgeType()))
                .map(edge -> edge.sourceNaturalKey() + "->" + edge.targetNaturalKey())
                .collect(Collectors.toSet());
    }
}
