package dev.codeintelligence.analysis.java;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.InventoriedFile;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Iterator;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class JavaParseSupportTest {

    @TempDir
    Path repo;

    /**
     * G-PERF finding 3: each annotation extractor parsed every Java file up front and held all
     * syntax trees at once, so heap (and with it the backend's resident memory) grew with the
     * project. Units must be parsed one at a time as the caller iterates.
     */
    @Test
    void parsesEachFileOnlyWhenTheCallerReachesIt() throws Exception {
        Files.writeString(repo.resolve("A.java"), "class A {}");
        Files.writeString(repo.resolve("B.java"), "class B {}");
        Files.writeString(repo.resolve("notes.txt"), "not java");
        AnalysisContext ctx = new AnalysisContext(
                1,
                1,
                repo,
                FileInventory.of(List.of(
                        new InventoriedFile("A.java", "java", 10, 1, "a"),
                        new InventoriedFile("notes.txt", null, 8, 1, "n"),
                        new InventoriedFile("B.java", "java", 10, 1, "b"))));

        Iterator<JavaParseSupport.ParsedJavaFile> units =
                JavaParseSupport.parseJavaFiles(ctx).iterator();
        assertThat(units.next().cu().getType(0).getNameAsString()).isEqualTo("A");
        Files.writeString(repo.resolve("B.java"), "class Later {}");

        assertThat(units.hasNext()).isTrue();
        assertThat(units.next().cu().getType(0).getNameAsString()).isEqualTo("Later");
        assertThat(units.hasNext()).isFalse();
    }
}
