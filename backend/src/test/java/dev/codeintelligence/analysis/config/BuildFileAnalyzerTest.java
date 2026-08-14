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
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class BuildFileAnalyzerTest {

    @TempDir
    Path temp;

    private final BuildFileAnalyzer analyzer = new BuildFileAnalyzer();

    @Test
    void gradleStringAndMapNotationExtractVersions() throws Exception {
        Path repo = temp.resolve("gradle");
        Files.createDirectories(repo);
        Files.writeString(repo.resolve("build.gradle"), """
                plugins { id 'java' }
                dependencies {
                    implementation 'org.springframework.boot:spring-boot-starter-web:3.4.0'
                    implementation 'org.postgresql:postgresql'
                    runtimeOnly("com.zaxxer:HikariCP:5.1.0")
                    testImplementation group: 'org.junit.jupiter', name: 'junit-jupiter', version: '5.11.0'
                    implementation(group = "com.google.guava", name = "guava", version = "33.0")
                    implementation 'org.springframework.boot:spring-boot-starter-web:3.4.0:plain'
                }
                """);
        AnalysisResult result = analyze(repo, "build.gradle", "gradle");
        assertThat(keys(result, "CONFIG")).contains(NaturalKeys.config("build.gradle"));
        assertThat(depKeys(result))
                .contains(
                        NaturalKeys.dependency("org.springframework.boot", "spring-boot-starter-web"),
                        NaturalKeys.dependency("org.postgresql", "postgresql"),
                        NaturalKeys.dependency("com.zaxxer", "HikariCP"),
                        NaturalKeys.dependency("org.junit.jupiter", "junit-jupiter"),
                        NaturalKeys.dependency("com.google.guava", "guava"));
        assertThat(dependsOn(result))
                .contains(NaturalKeys.config("build.gradle") + "->"
                        + NaturalKeys.dependency("org.springframework.boot", "spring-boot-starter-web"));
        assertThat(result.nodes().stream()
                        .filter(node -> node.naturalKey().startsWith("dep:"))
                        .map(node -> node.name() + "=" + node.metadata().get("version"))
                        .toList())
                .contains(
                        "spring-boot-starter-web=3.4.0",
                        "HikariCP=5.1.0",
                        "junit-jupiter=5.11.0",
                        "guava=33.0",
                        "postgresql=null");
    }

    @Test
    void gradleKtsStringNotation() throws Exception {
        Path repo = temp.resolve("kts");
        Files.createDirectories(repo);
        Files.writeString(repo.resolve("build.gradle.kts"), """
                dependencies {
                    implementation("org.springframework.boot:spring-boot-starter-data-jpa:3.4.1")
                }
                """);
        AnalysisResult result = analyze(repo, "build.gradle.kts", "gradle");
        assertThat(versionOf(result, "spring-boot-starter-data-jpa")).isEqualTo("3.4.1");
    }

    @Test
    void pomDomExtractsPropertyAndLiteralVersions() throws Exception {
        Path repo = temp.resolve("pom");
        Files.createDirectories(repo);
        Files.writeString(repo.resolve("pom.xml"), """
                <project>
                  <modelVersion>4.0.0</modelVersion>
                  <groupId>com.example</groupId>
                  <artifactId>todo</artifactId>
                  <version>1.0.0</version>
                  <dependencies>
                    <dependency>
                      <groupId>org.springframework.boot</groupId>
                      <artifactId>spring-boot-starter-web</artifactId>
                      <version>3.4.0</version>
                    </dependency>
                    <dependency>
                      <groupId>org.postgresql</groupId>
                      <artifactId>postgresql</artifactId>
                      <version>${postgresql.version}</version>
                      <scope>runtime</scope>
                    </dependency>
                  </dependencies>
                </project>
                """);
        AnalysisResult result = analyze(repo, "pom.xml", "xml");
        assertThat(depKeys(result))
                .containsExactlyInAnyOrder(
                        NaturalKeys.dependency("org.springframework.boot", "spring-boot-starter-web"),
                        NaturalKeys.dependency("org.postgresql", "postgresql"));
        assertThat(versionOf(result, "spring-boot-starter-web")).isEqualTo("3.4.0");
        assertThat(versionOf(result, "postgresql")).isEqualTo("${postgresql.version}");
        assertThat(dependsOn(result)).hasSize(2);
    }

    private AnalysisResult analyze(Path repo, String path, String language) {
        FileInventory inventory = FileInventory.of(new InventoriedFile(path, language, 0, 0, ""));
        return analyzer.analyze(new AnalysisContext(1, 1, repo, inventory));
    }

    private static Set<String> keys(AnalysisResult result, String type) {
        return result.nodes().stream()
                .filter(node -> type.equals(node.nodeType()))
                .map(GraphNodeDraft::naturalKey)
                .collect(Collectors.toSet());
    }

    private static Set<String> depKeys(AnalysisResult result) {
        return result.nodes().stream()
                .map(GraphNodeDraft::naturalKey)
                .filter(key -> key.startsWith("dep:"))
                .collect(Collectors.toSet());
    }

    private static Set<String> dependsOn(AnalysisResult result) {
        return result.edges().stream()
                .filter(edge -> "DEPENDS_ON".equals(edge.edgeType()))
                .map(edge -> edge.sourceNaturalKey() + "->" + edge.targetNaturalKey())
                .collect(Collectors.toSet());
    }

    private static String versionOf(AnalysisResult result, String artifact) {
        return result.nodes().stream()
                .filter(node ->
                        artifact.equals(node.name()) && node.naturalKey().startsWith("dep:"))
                .findFirst()
                .map(node -> (String) node.metadata().get("version"))
                .orElse(null);
    }
}
