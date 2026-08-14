package dev.codeintelligence.analysis.java;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphEdgeDraft;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.InventoriedFile;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SpringEndpointExtractorTest {

    @TempDir
    Path temp;

    @Test
    void synthesizesClassPrefixPathVariablesAndNormalizesSlashes() throws Exception {
        Path file = write("src/main/java/demo/ApiController.java", """
                package demo;
                import org.springframework.web.bind.annotation.*;
                @RestController
                @RequestMapping("/api/")
                class ApiController {
                  @GetMapping("/todos/{id}")
                  Object get() { return null; }
                  @PostMapping("todos")
                  Object create() { return null; }
                }
                """);
        AnalysisResult result = analyze(file);
        assertThat(keys(result, "API_ENDPOINT"))
                .containsExactlyInAnyOrder("endpoint:GET:/api/todos/{id}", "endpoint:POST:/api/todos");
        assertThat(result.edges().stream().map(GraphEdgeDraft::edgeType).collect(Collectors.toSet()))
                .contains("EXPOSES");
    }

    @Test
    void controllerPlusResponseBodyIsTreatedAsRestController() throws Exception {
        Path file = write("src/main/java/demo/LegacyController.java", """
                package demo;
                import org.springframework.stereotype.Controller;
                import org.springframework.web.bind.annotation.*;
                @Controller
                @ResponseBody
                @RequestMapping("/legacy")
                class LegacyController {
                  @GetMapping
                  String ping() { return "ok"; }
                }
                """);
        AnalysisResult result = analyze(file);
        assertThat(keys(result, "API_ENDPOINT")).containsExactly("endpoint:GET:/legacy");
    }

    private Path write(String relative, String source) throws Exception {
        Path file = temp.resolve(relative);
        Files.createDirectories(file.getParent());
        Files.writeString(file, source);
        return file;
    }

    private AnalysisResult analyze(Path file) {
        String rel = temp.relativize(file).toString().replace('\\', '/');
        FileInventory inventory = FileInventory.of(new InventoriedFile(rel, "java", 0, 0, ""));
        return new SpringEndpointExtractor().analyze(new AnalysisContext(1, 1, temp, inventory));
    }

    private static Set<String> keys(AnalysisResult result, String nodeType) {
        return result.nodes().stream()
                .filter(node -> nodeType.equals(node.nodeType()))
                .map(GraphNodeDraft::naturalKey)
                .collect(Collectors.toSet());
    }
}
