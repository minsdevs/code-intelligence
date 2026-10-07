package dev.codeintelligence.analysis.java;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.InventoriedFile;
import java.lang.management.ManagementFactory;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * G-PERF medium failed with OutOfMemoryError in SOURCE_PARSING: the analyzer kept every syntax tree
 * (about 80x its source) for its three passes, and the symbol solver cached its own copy of every
 * file it resolved into, still reachable after the analysis returned. Beyond the result itself, the
 * live heap while analyzing must stay small, and nothing but the result may outlive the analysis.
 */
class JavaAnalyzerMemoryTest {

    private static final int FILES = 1_200;
    private static final long MiB = 1024 * 1024;

    @TempDir
    Path repo;

    @Test
    void liveHeapDuringAnalysisDoesNotHoldEverySyntaxTree() throws Exception {
        List<InventoriedFile> files = new ArrayList<>();
        long sourceBytes = 0;
        for (int i = 0; i < FILES; i++) {
            String path = "src/main/java/p" + (i % 20) + "/C" + i + ".java";
            String source = source(i);
            Files.createDirectories(repo.resolve(path).getParent());
            Files.writeString(repo.resolve(path), source);
            files.add(new InventoriedFile(path, "java", source.length(), 1, "h" + i));
            sourceBytes += source.length();
        }
        AnalysisContext ctx = new AnalysisContext(1, 1, repo, FileInventory.of(files));

        long baseline = liveHeap();
        AtomicLong peak = new AtomicLong(baseline);
        Thread sampler = Thread.ofPlatform().daemon().start(() -> {
            // A full collection every 100 ms; continuous collections would starve the analysis.
            while (!Thread.currentThread().isInterrupted()) {
                peak.accumulateAndGet(liveHeap(), Math::max);
                try {
                    Thread.sleep(100);
                } catch (InterruptedException e) {
                    return;
                }
            }
        });
        AnalysisResult result;
        try {
            result = new JavaAnalyzer().analyze(ctx);
        } finally {
            sampler.interrupt();
            sampler.join();
        }
        long withResult = liveHeap();
        assertThat(result.fileOutcomes())
                .hasSize(FILES)
                .noneMatch(outcome -> outcome.status().equals("FAILED"));
        assertThat(result.edges())
                .filteredOn(edge ->
                        edge.edgeType().equals("CALLS") && edge.confidence().equals("CONFIRMED"))
                .hasSize((FILES - 1) * 4);
        result = null;
        long afterwards = liveHeap();

        // Each copy of this corpus' trees is about 230 MiB. One file at a time plus the bounded
        // solver caches (and the analyzer's own maps beside the result) stays well below one copy.
        long working = (peak.get() - withResult) / MiB;
        long leftOver = (afterwards - baseline) / MiB;
        System.out.printf(
                "%d bytes of source: peak %d MiB over baseline, result %d MiB, left over %d MiB%n",
                sourceBytes, (peak.get() - baseline) / MiB, (withResult - baseline) / MiB, leftOver);
        assertThat(sourceBytes).isGreaterThan(1_700_000);
        assertThat(working).as("peak live heap beyond the result (MiB)").isLessThan(100);
        assertThat(leftOver).as("live heap left over after the analysis (MiB)").isLessThan(10);
    }

    private static long liveHeap() {
        System.gc();
        return ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed();
    }

    /** Each class calls its predecessor in another package, so resolution goes through the type solver. */
    private static String source(int i) {
        StringBuilder text = new StringBuilder();
        text.append("package p").append(i % 20).append(";\n\n");
        if (i > 0)
            text.append("import p")
                    .append((i - 1) % 20)
                    .append(".C")
                    .append(i - 1)
                    .append(";\n\n");
        text.append("public class C").append(i).append(" {\n");
        if (i > 0)
            text.append("    private final C")
                    .append(i - 1)
                    .append(" previous = new C")
                    .append(i - 1)
                    .append("();\n");
        for (int m = 0; m < 4; m++) {
            text.append("    public int step").append(m).append("(int value) {\n");
            text.append("        int total = value * ")
                    .append(m + 3)
                    .append(" + ")
                    .append(i)
                    .append(";\n");
            text.append("        for (int index = 0; index < ").append(m + 2).append("; index++) {\n");
            text.append("            total = total + index * value - (index % 3);\n");
            text.append("        }\n");
            text.append("        String label = \"step-")
                    .append(i)
                    .append('-')
                    .append(m)
                    .append("\" + total;\n");
            text.append("        total += label.length();\n");
            if (i > 0) text.append("        total += previous.step").append(m).append("(total);\n");
            text.append("        return total;\n");
            text.append("    }\n");
        }
        text.append("}\n");
        return text.toString();
    }
}
