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
                        BuildFileAnalyzer.declarationKey(
                                "build.gradle",
                                "implementation",
                                "org.springframework.boot",
                                "spring-boot-starter-web",
                                "org.springframework.boot:spring-boot-starter-web:3.4.0"),
                        BuildFileAnalyzer.declarationKey(
                                "build.gradle",
                                "implementation",
                                "org.postgresql",
                                "postgresql",
                                "org.postgresql:postgresql"),
                        BuildFileAnalyzer.declarationKey(
                                "build.gradle", "runtimeOnly", "com.zaxxer", "HikariCP", "com.zaxxer:HikariCP:5.1.0"),
                        BuildFileAnalyzer.declarationKey(
                                "build.gradle",
                                "testImplementation",
                                "org.junit.jupiter",
                                "junit-jupiter",
                                "org.junit.jupiter:junit-jupiter:5.11.0"),
                        BuildFileAnalyzer.declarationKey(
                                "build.gradle",
                                "implementation",
                                "com.google.guava",
                                "guava",
                                "com.google.guava:guava:33.0"));
        assertThat(dependsOn(result))
                .contains(NaturalKeys.config("build.gradle") + "->"
                        + BuildFileAnalyzer.declarationKey(
                                "build.gradle",
                                "implementation",
                                "org.springframework.boot",
                                "spring-boot-starter-web",
                                "org.springframework.boot:spring-boot-starter-web:3.4.0"));
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
                        BuildFileAnalyzer.declarationKey(
                                "pom.xml",
                                "compile",
                                "org.springframework.boot",
                                "spring-boot-starter-web",
                                "org.springframework.boot:spring-boot-starter-web:3.4.0"),
                        BuildFileAnalyzer.declarationKey(
                                "pom.xml",
                                "runtime",
                                "org.postgresql",
                                "postgresql",
                                "org.postgresql:postgresql:${postgresql.version}"));
        assertThat(versionOf(result, "spring-boot-starter-web")).isEqualTo("3.4.0");
        assertThat(versionOf(result, "postgresql")).isEqualTo("${postgresql.version}");
        assertThat(dependsOn(result)).hasSize(2);
    }

    @Test
    void npmDeclarationsKeepDifferentModulesVersionsAndManifestEvidence() throws Exception {
        Files.createDirectories(temp.resolve("app"));
        Files.createDirectories(temp.resolve("worker"));
        Files.writeString(temp.resolve("app/package.json"), """
                {"dependencies":{"shared":"^1.0.0"},"devDependencies":{"tool":"2"},
                 "scripts":{"postinstall":"must never execute"}}
                """);
        Files.writeString(temp.resolve("worker/package.json"), """
                {"dependencies":{"shared":"^2.0.0"},"peerDependencies":{"host":"*"}}
                """);
        FileInventory inventory = FileInventory.of(List.of(
                new InventoriedFile("app/package.json", "json", 0, 0, ""),
                new InventoriedFile("worker/package.json", "json", 0, 0, "")));
        AnalysisResult result = analyzer.analyze(new AnalysisContext(1, 1, temp, inventory));
        var shared = result.nodes().stream()
                .filter(node -> node.name().equals("shared"))
                .toList();
        assertThat(shared).hasSize(2);
        assertThat(shared).extracting(GraphNodeDraft::naturalKey).doesNotHaveDuplicates();
        assertThat(shared)
                .extracting(GraphNodeDraft::filePath)
                .containsExactly("app/package.json", "worker/package.json");
        assertThat(shared).extracting(node -> node.metadata().get("version")).containsExactly("^1.0.0", "^2.0.0");
        assertThat(result.edges())
                .filteredOn(edge -> edge.edgeType().equals("DEPENDS_ON"))
                .hasSize(4);
        for (GraphNodeDraft node : shared) {
            assertThat(result.evidences())
                    .anyMatch(evidence -> node.naturalKey().equals(evidence.subjectNaturalKey())
                            && node.filePath().equals(evidence.filePath()));
        }
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
