package dev.codeintelligence.analysis.java;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.analysis.core.NaturalKeys;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class KafkaEventExtractorTest {

    @TempDir
    Path temp;

    @Test
    void extractsListenerAndSend() throws Exception {
        Path file = temp.resolve("src/main/java/demo/Worker.java");
        Files.createDirectories(file.getParent());
        Files.writeString(file, """
                package demo;
                import org.springframework.kafka.annotation.KafkaListener;
                import org.springframework.kafka.core.KafkaTemplate;
                class Worker {
                  KafkaTemplate<String, String> kafkaTemplate;
                  @KafkaListener(topics = "orders")
                  void onOrder(String body) {}
                  void publish() { kafkaTemplate.send("orders", "x"); }
                }
                """);
        var result = new KafkaEventExtractor()
                .analyze(new AnalysisContext(
                        1,
                        1,
                        temp,
                        FileInventory.of(new InventoriedFile("src/main/java/demo/Worker.java", "java", 100, 10, "h"))));
        assertThat(result.nodes()).extracting(node -> node.naturalKey()).contains(NaturalKeys.topic("orders"));
        assertThat(result.edges())
                .anyMatch(edge -> "SUBSCRIBES".equals(edge.edgeType())
                        && NaturalKeys.topic("orders").equals(edge.targetNaturalKey()));
        assertThat(result.edges())
                .anyMatch(edge -> "PUBLISHES".equals(edge.edgeType())
                        && NaturalKeys.topic("orders").equals(edge.targetNaturalKey()));
    }
}
