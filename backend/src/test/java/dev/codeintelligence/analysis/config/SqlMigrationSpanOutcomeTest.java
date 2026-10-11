package dev.codeintelligence.analysis.config;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.InventoriedFile;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** G-ACCURACY D5 (per-file SQL parse verdict) and D6 (statement and column line evidence). */
class SqlMigrationSpanOutcomeTest {

    @TempDir
    Path temp;

    private final SqlMigrationAnalyzer analyzer = new SqlMigrationAnalyzer();

    private static InventoriedFile file(String path) {
        return new InventoriedFile(path, "sql", 0, 1, "");
    }

    @Test
    void createTablePublishesStatementLinesColumnLinesAndASuccessVerdict() throws Exception {
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
        AnalysisResult result = analyzer.analyze(new AnalysisContext(
                1, 1, repo, FileInventory.of(List.of(file("src/main/resources/db/migration/V1__create_todos.sql")))));
        GraphNodeDraft table = result.nodes().stream()
                .filter(node -> node.nodeType().equals("DB_TABLE"))
                .findFirst()
                .orElseThrow();
        assertThat(table.lineStart()).isEqualTo(1);
        assertThat(table.lineEnd()).isEqualTo(5);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> columns =
                (List<Map<String, Object>>) table.metadata().get("columns");
        assertThat(columns)
                .extracting(
                        column -> column.get("name"),
                        column -> column.get("lineStart"),
                        column -> column.get("lineEnd"))
                .containsExactly(
                        org.assertj.core.groups.Tuple.tuple("id", 2, 2),
                        org.assertj.core.groups.Tuple.tuple("title", 3, 3),
                        org.assertj.core.groups.Tuple.tuple("done", 4, 4));
        assertThat(columns).allSatisfy(column -> assertThat(column).doesNotContainKey("path"));
        assertThat(result.fileOutcomes())
                .singleElement()
                .matches(outcome -> outcome.path().equals("src/main/resources/db/migration/V1__create_todos.sql")
                        && outcome.status().equals("SUCCESS")
                        && outcome.reason().equals("SQL_PARSED"));
    }

    @Test
    void parseFailureIsAPerFileVerdictAndKeepsTheOtherFileSuccessful() throws Exception {
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
        assertThat(result.fileOutcomes())
                .extracting(outcome -> outcome.path(), outcome -> outcome.status(), outcome -> outcome.reason())
                .containsExactlyInAnyOrder(
                        org.assertj.core.groups.Tuple.tuple(
                                "src/main/resources/db/migration/V1__ok.sql", "SUCCESS", "SQL_PARSED"),
                        org.assertj.core.groups.Tuple.tuple(
                                "src/main/resources/db/migration/V2__broken.sql", "FAILED", "SQL_PARSE_FAILED"));
        GraphNodeDraft table = result.nodes().stream()
                .filter(node -> node.nodeType().equals("DB_TABLE"))
                .findFirst()
                .orElseThrow();
        assertThat(table.lineStart()).isEqualTo(1);
        assertThat(table.lineEnd()).isEqualTo(1);
    }

    @Test
    void columnsAddedByALaterMigrationKeepTheirOwnFileAndAmbiguousLinesClaimNoSpan() throws Exception {
        Path repo = temp.resolve("alter");
        Path dir = repo.resolve("src/main/resources/db/migration");
        Files.createDirectories(dir);
        Files.writeString(dir.resolve("V1__create.sql"), "CREATE TABLE t (\n  a int,\n  b int\n);\n");
        Files.writeString(dir.resolve("V2__alter.sql"), "ALTER TABLE t ADD COLUMN c int;\n");
        AnalysisResult result = analyzer.analyze(new AnalysisContext(
                1,
                1,
                repo,
                FileInventory.of(List.of(
                        file("src/main/resources/db/migration/V1__create.sql"),
                        file("src/main/resources/db/migration/V2__alter.sql")))));
        GraphNodeDraft table = result.nodes().stream()
                .filter(node -> node.nodeType().equals("DB_TABLE"))
                .findFirst()
                .orElseThrow();
        assertThat(table.filePath()).isEqualTo("src/main/resources/db/migration/V1__create.sql");
        assertThat(table.lineEnd()).isEqualTo(4);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> columns =
                (List<Map<String, Object>>) table.metadata().get("columns");
        assertThat(columns).extracting(column -> column.get("name")).containsExactly("a", "b", "c");
        assertThat(columns.get(0)).containsEntry("lineStart", 2);
        assertThat(columns.get(1)).containsEntry("lineStart", 3);
        // ALTER-added columns are not located: no span is claimed for them (fail closed).
        assertThat(columns.get(2)).doesNotContainKey("lineStart");
    }
}
