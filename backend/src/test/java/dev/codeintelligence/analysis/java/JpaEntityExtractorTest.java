package dev.codeintelligence.analysis.java;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.InventoriedFile;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class JpaEntityExtractorTest {

    @TempDir
    Path temp;

    @Test
    void usesTableNameWhenPresent() throws Exception {
        AnalysisResult result = analyze("Todo.java", """
                package demo;
                import jakarta.persistence.*;
                @Entity
                @Table(name = "todos")
                class Todo {}
                """);
        GraphNodeDraft node = result.nodes().getFirst();
        assertThat(node.nodeType()).isEqualTo("DB_ENTITY");
        assertThat(node.metadata().get("tableName")).isEqualTo("todos");
        assertThat(node.metadata().get("source")).isEqualTo("JPA");
    }

    @Test
    void defaultsToSnakeCaseWhenTableOmitted() throws Exception {
        AnalysisResult result = analyze("OrderItem.java", """
                package demo;
                import jakarta.persistence.Entity;
                @Entity
                class OrderItem {}
                """);
        assertThat(result.nodes().getFirst().metadata().get("tableName")).isEqualTo("order_item");
        assertThat(result.nodes().getFirst().naturalKey()).isEqualTo("entity:demo.OrderItem");
    }

    private AnalysisResult analyze(String name, String source) throws Exception {
        Path file = temp.resolve("src/main/java/demo/" + name);
        Files.createDirectories(file.getParent());
        Files.writeString(file, source);
        String rel = temp.relativize(file).toString().replace('\\', '/');
        return new JpaEntityExtractor()
                .analyze(new AnalysisContext(1, 1, temp, FileInventory.of(new InventoriedFile(rel, "java", 0, 0, ""))));
    }
}
