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
     * G-PERF medium/large SOURCE_PARSING: parsing was most of the step's CPU time and ran on the
     * job thread only. Files are now parsed a few ahead on helper threads while the caller walks the
     * current tree, still delivered in order and still bounded: never the whole project (G-PERF
     * finding 3: the extractors once held every syntax tree at once; this test replaces the earlier
     * strictly one-at-a-time {@code parsesEachFileOnlyWhenTheCallerReachesIt}).
     */
    @Test
    void parsesABoundedNumberOfFilesAheadAndDeliversThemInOrder() throws Exception {
        int files = 4 * ParseAhead.AHEAD + 4;
        List<InventoriedFile> inventory = new java.util.ArrayList<>();
        for (int i = 0; i < files; i++) {
            Files.writeString(repo.resolve("F" + i + ".java"), "class F" + i + " {}");
            inventory.add(new InventoriedFile("F" + i + ".java", "java", 10, 1, "f" + i));
        }
        AnalysisContext ctx = new AnalysisContext(1, 1, repo, FileInventory.of(inventory));

        Iterator<JavaParseSupport.ParsedJavaFile> units =
                JavaParseSupport.parseJavaFiles(ctx).iterator();
        assertThat(units.next().cu().getType(0).getNameAsString()).isEqualTo("F0");
        // While the caller works on F0, the helpers parse ahead; then every later file changes.
        Thread.sleep(1_000);
        for (int i = 1; i < files; i++) Files.writeString(repo.resolve("F" + i + ".java"), "class Later" + i + " {}");

        int parsedAhead = 0;
        for (int i = 1; i < files; i++) {
            String name = units.next().cu().getType(0).getNameAsString();
            assertThat(name).isIn("F" + i, "Later" + i);
            if (name.equals("F" + i)) parsedAhead++;
        }
        assertThat(units.hasNext()).isFalse();
        assertThat(parsedAhead).isBetween(1, ParseAhead.AHEAD);
    }
}
