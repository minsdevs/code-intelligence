package dev.codeintelligence.analysis.config;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.CodeAnalyzer;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.analysis.core.NaturalKeys;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * CONFIG and MIGRATION file facts span the whole file: {@code lineEnd} is the line holding the last byte. LF, CRLF and
 * a lone CR terminate a line; a final terminator does not open another line (G-EVIDENCE F-3).
 */
class ConfigSpanLineEndTest {

    private static final String MIGRATION = "db/migration/V1__init.sql";

    @TempDir
    Path temp;

    @Test
    void packageJsonSpanEndsOnItsLastLine() throws Exception {
        assertLineEnd(
                new BuildFileAnalyzer(), "package.json", "{\"name\":\"a\"}\n", NaturalKeys.config("package.json"), 1);
        assertLineEnd(
                new BuildFileAnalyzer(), "package.json", "{\"name\":\"a\"}", NaturalKeys.config("package.json"), 1);
        assertLineEnd(
                new BuildFileAnalyzer(),
                "package.json",
                "{\r\n\"name\":\"a\"\r\n}\r\n",
                NaturalKeys.config("package.json"),
                3);
        assertLineEnd(
                new BuildFileAnalyzer(), "package.json", "{\r\"name\":\"a\"\r}", NaturalKeys.config("package.json"), 3);
    }

    @Test
    void gradleAndPomSpansEndOnTheirLastLine() throws Exception {
        assertLineEnd(
                new BuildFileAnalyzer(),
                "build.gradle",
                "plugins { id 'java' }\ndependencies {\n}\n",
                NaturalKeys.config("build.gradle"),
                3);
        assertLineEnd(
                new BuildFileAnalyzer(),
                "pom.xml",
                "<project>\r\n<artifactId>a</artifactId>\r\n</project>",
                NaturalKeys.config("pom.xml"),
                3);
    }

    @Test
    void applicationYamlSpanEndsOnItsLastLine() throws Exception {
        String key = NaturalKeys.config("application.yml");
        assertLineEnd(new YamlConfigAnalyzer(), "application.yml", "server:\n  port: 8080\n", key, 2);
        assertLineEnd(new YamlConfigAnalyzer(), "application.yml", "server:\r\n  port: 8080\r\n", key, 2);
        assertLineEnd(new YamlConfigAnalyzer(), "application.yml", "server:\r\n  port: 8080", key, 2);
    }

    @Test
    void migrationSpanEndsOnItsLastLine() throws Exception {
        String key = NaturalKeys.migration(MIGRATION);
        assertLineEnd(new SqlMigrationAnalyzer(), MIGRATION, "CREATE TABLE a (id int);\n", key, 1);
        assertLineEnd(new SqlMigrationAnalyzer(), MIGRATION, "CREATE TABLE a (\r\n  id int\r\n);\r\n", key, 3);
        assertLineEnd(new SqlMigrationAnalyzer(), MIGRATION, "CREATE TABLE a (\n  id int\n);", key, 3);
        assertLineEnd(new SqlMigrationAnalyzer(), MIGRATION, "CREATE TABLE a (id int);\n\n", key, 2);
    }

    private void assertLineEnd(CodeAnalyzer analyzer, String path, String content, String key, int expectedEnd)
            throws Exception {
        Path repo = Files.createTempDirectory(temp, "repo");
        Path file = repo.resolve(path);
        Files.createDirectories(file.getParent());
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        Files.write(file, bytes);
        AnalysisResult result = analyzer.analyze(new AnalysisContext(
                1, 1, repo, FileInventory.of(new InventoriedFile(path, "text", bytes.length, null, ""))));
        GraphNodeDraft node = result.nodes().stream()
                .filter(candidate -> key.equals(candidate.naturalKey()))
                .findFirst()
                .orElseThrow();
        assertThat(node.lineStart()).isEqualTo(1);
        assertThat(node.lineEnd())
                .as("lineEnd of %s for %s", key, content.replace("\r", "\\r").replace("\n", "\\n"))
                .isEqualTo(expectedEnd)
                .isEqualTo(lineOfLastByte(bytes));
    }

    /** 1-based line of the file's last byte, splitting on LF, CRLF and lone CR like the evidence audit. */
    private static int lineOfLastByte(byte[] bytes) {
        int line = 1;
        for (int i = 0; i < bytes.length - 1; i++) {
            if (bytes[i] == '\n' || (bytes[i] == '\r' && bytes[i + 1] != '\n')) {
                line++;
            }
        }
        return line;
    }
}
