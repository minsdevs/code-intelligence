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

class SqlMigrationAnalyzerTest {

    @TempDir
    Path temp;

    private final SqlMigrationAnalyzer analyzer = new SqlMigrationAnalyzer();

    @Test
    void flywayCreateAndIndexYieldTableAndTwoMigrations() throws Exception {
        Path repo = temp.resolve("db");
        Path dir = repo.resolve("src/main/resources/db/migration");
        Files.createDirectories(dir);
        Files.writeString(dir.resolve("V1__create_todos.sql"), """
                CREATE TABLE todos (
                    id bigserial PRIMARY KEY,
                    title text NOT NULL,
                    done boolean NOT NULL DEFAULT false
                );
                """);
        Files.writeString(
                dir.resolve("V2__add_todos_done_index.sql"), "CREATE INDEX idx_todos_done ON todos (done);\n");
        AnalysisResult result = analyzer.analyze(new AnalysisContext(
                1,
                1,
                repo,
                FileInventory.of(List.of(
                        file("src/main/resources/db/migration/V1__create_todos.sql"),
                        file("src/main/resources/db/migration/V2__add_todos_done_index.sql")))));
        assertThat(keys(result, "DB_TABLE")).containsExactly(NaturalKeys.table("todos"));
        assertThat(keys(result, "MIGRATION"))
                .containsExactlyInAnyOrder(
                        NaturalKeys.migration("src/main/resources/db/migration/V1__create_todos.sql"),
                        NaturalKeys.migration("src/main/resources/db/migration/V2__add_todos_done_index.sql"));
    }

    @Test
    void brokenSqlIsDemotedToFileLevelMigrationWithEvidence() throws Exception {
        Path repo = temp.resolve("broken");
        Path dir = repo.resolve("src/main/resources/db/migration");
        Files.createDirectories(dir);
        Files.writeString(dir.resolve("V1__ok.sql"), "CREATE TABLE notes (id int PRIMARY KEY);\n");
        Files.writeString(dir.resolve("V2__broken.sql"), "this is not sql [[[ unterminated\n");
        AnalysisResult result = analyzer.analyze(new AnalysisContext(
                1,
                1,
                repo,
                FileInventory.of(List.of(
                        file("src/main/resources/db/migration/V1__ok.sql"),
                        file("src/main/resources/db/migration/V2__broken.sql")))));
        assertThat(keys(result, "DB_TABLE")).containsExactly(NaturalKeys.table("notes"));
        assertThat(keys(result, "MIGRATION"))
                .contains(NaturalKeys.migration("src/main/resources/db/migration/V2__broken.sql"));
        assertThat(result.evidences())
                .anyMatch(evidence -> "src/main/resources/db/migration/V2__broken.sql".equals(evidence.filePath())
                        && evidence.excerpt() != null
                        && evidence.excerpt().contains("SQL parse failed"));
    }

    private static InventoriedFile file(String path) {
        return new InventoriedFile(path, "sql", 0, 0, "");
    }

    private static Set<String> keys(AnalysisResult result, String type) {
        return result.nodes().stream()
                .filter(node -> type.equals(node.nodeType()))
                .map(GraphNodeDraft::naturalKey)
                .collect(Collectors.toSet());
    }
}
