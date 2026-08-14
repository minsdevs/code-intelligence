package dev.codeintelligence.analysis.java;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.InventoriedFile;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class LayerTaggerTest {

    @TempDir
    Path temp;

    @Test
    void tagsSpringStereotypesAndJpaRepository() throws Exception {
        write("C.java", """
                package demo;
                import org.springframework.web.bind.annotation.RestController;
                import org.springframework.stereotype.Service;
                import org.springframework.stereotype.Repository;
                import org.springframework.data.jpa.repository.JpaRepository;
                import jakarta.persistence.Entity;
                @RestController class C {}
                @Service class S {}
                @Repository class R {}
                interface Repo extends JpaRepository<Object, Long> {}
                @Entity class E {}
                """);
        AnalysisResult result = new LayerTagger()
                .analyze(new AnalysisContext(
                        1,
                        1,
                        temp,
                        FileInventory.of(new InventoriedFile("src/main/java/demo/C.java", "java", 0, 0, ""))));
        Map<String, String> layers = result.nodes().stream()
                .collect(Collectors.toMap(
                        GraphNodeDraft::name,
                        node -> String.valueOf(node.metadata().get("layer"))));
        assertThat(layers)
                .containsEntry("C", "CONTROLLER")
                .containsEntry("S", "SERVICE")
                .containsEntry("R", "REPOSITORY")
                .containsEntry("Repo", "REPOSITORY")
                .containsEntry("E", "ENTITY");
    }

    private void write(String name, String source) throws Exception {
        Path file = temp.resolve("src/main/java/demo/" + name);
        Files.createDirectories(file.getParent());
        Files.writeString(file, source);
    }
}
