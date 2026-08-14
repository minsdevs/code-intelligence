package dev.codeintelligence.analysis.config;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.analysis.core.NaturalKeys;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class TerraformAnalyzerTest {

    @TempDir
    Path temp;

    @Test
    void extractsResourceBlocks() throws Exception {
        Path file = temp.resolve("main.tf");
        Files.writeString(file, """
                resource "aws_s3_bucket" "data" {
                  bucket = "example"
                }
                """);
        var result = new TerraformAnalyzer()
                .analyze(new AnalysisContext(
                        1, 1, temp, FileInventory.of(new InventoriedFile("main.tf", "hcl", 40, 3, "h"))));
        assertThat(result.nodes())
                .extracting(node -> node.naturalKey())
                .contains(NaturalKeys.cloud("aws_s3_bucket", "data"));
    }
}
