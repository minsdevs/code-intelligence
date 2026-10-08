package dev.codeintelligence.analysis.java;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.InventoriedFile;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class JavaIncrementalTest {
    @TempDir Path root;

    @Test
    void unchangedRefreshReusesCompletedResult() throws Exception {
        Files.writeString(root.resolve("A.java"), "class A { int value() { return 1; } }");
        JavaAnalyzer analyzer = new JavaAnalyzer();
        AnalysisResult first = analyzer.analyze(context());
        assertThat(analyzer.analyze(context())).isSameAs(first);
    }

    private AnalysisContext context() throws Exception {
        try (var paths = Files.list(root)) {
            List<InventoriedFile> files = paths.sorted().map(path -> {
                try {
                    return new InventoriedFile(path.getFileName().toString(), "java", Files.size(path), 1, "");
                } catch (Exception failure) { throw new IllegalStateException(failure); }
            }).toList();
            return new AnalysisContext(1, 2, root, FileInventory.of(files));
        }
    }
}
