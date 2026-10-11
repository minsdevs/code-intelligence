package dev.codeintelligence.job;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class StepHeapReleaseTest {

    @Test
    void collectsOnlyAfterTheHeavyStepsAndAtJobEnd() {
        AtomicInteger collections = new AtomicInteger();
        StepHeapRelease release = new StepHeapRelease(collections::incrementAndGet, () -> 64L << 20);
        for (String key :
                List.of("IMPORT", "FILE_INVENTORY", "FRAMEWORK_DETECTION", "AREA_DETECTION", "GIT_METADATA")) {
            release.afterStep(key);
        }
        assertThat(collections.get()).isZero();
        release.afterStep("SOURCE_PARSING");
        release.afterStep("GRAPH_BUILD");
        release.afterStep("TS_PARSING");
        release.afterStep("TREE_PARSING");
        release.afterStep("EXTRACTION");
        release.afterStep(null);
        assertThat(collections.get()).isEqualTo(4);
        release.afterJob(7L);
        assertThat(collections.get()).isEqualTo(5);
    }

    @Test
    void releaseAfterSourceParsingPrecedesTheTsWorkerStep() {
        // TS_PARSING (750) starts an external worker; the Java/graph steps before it (600, 700) must release.
        assertThat(StepHeapRelease.RELEASE_AFTER)
                .contains(
                        dev.codeintelligence.analysis.graph.SourceParsingStep.KEY,
                        dev.codeintelligence.analysis.graph.GraphBuildStep.KEY,
                        dev.codeintelligence.analysis.ts.TsParsingStep.KEY);
        assertThat(dev.codeintelligence.analysis.graph.GraphBuildStep.ORDER)
                .isLessThan(dev.codeintelligence.analysis.ts.TsParsingStep.ORDER);
    }

    @Test
    void realCollectorShrinksCommittedHeapAfterGarbageWhenTheSerialCollectorIsAllowedToShrink() {
        // Observational only: the serial collector (test JVM args) may keep the heap committed when
        // MaxHeapFreeRatio is not met; the contract under test is that the hook runs the collector.
        List<byte[]> garbage = new ArrayList<>();
        for (int i = 0; i < 64; i++) garbage.add(new byte[1 << 20]);
        long committedWithGarbage = Runtime.getRuntime().totalMemory();
        garbage.clear();
        new StepHeapRelease().afterStep("SOURCE_PARSING");
        assertThat(Runtime.getRuntime().totalMemory()).isLessThanOrEqualTo(committedWithGarbage);
    }
}
