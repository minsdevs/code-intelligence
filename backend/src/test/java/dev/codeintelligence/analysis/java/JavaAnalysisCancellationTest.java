package dev.codeintelligence.analysis.java;

import static dev.codeintelligence.analysis.java.JavaIncrementalTest.context;
import static dev.codeintelligence.analysis.java.JavaIncrementalTest.write;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.CodeAnalyzer;
import dev.codeintelligence.job.JobCancelledException;
import java.nio.file.Path;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;
import org.junit.jupiter.api.io.TempDir;

class JavaAnalysisCancellationTest {
    @TempDir
    Path root;

    @TestFactory
    Stream<DynamicTest> queuedAnalysisCancelsBeforeTheFirstParserCompletes() {
        return Stream.<CodeAnalyzer>of(new JavaAnalyzer(), new JavaFrameworkAnalyzer())
                .map(analyzer -> DynamicTest.dynamicTest(analyzer.getClass().getSimpleName(), () -> check(analyzer)));
    }

    private void check(CodeAnalyzer analyzer) throws Exception {
        write(root, "A.java", "@org.springframework.stereotype.Service class A { int value(){ return 1; } }");
        AnalysisContext original = context(root);
        AnalysisContext blocked = mock(AnalysisContext.class);
        when(blocked.projectId()).thenReturn(original.projectId());
        when(blocked.snapshotId()).thenReturn(original.snapshotId());
        when(blocked.inventory()).thenReturn(original.inventory());
        CountDownLatch parserEntered = new CountDownLatch(1);
        CountDownLatch releaseParser = new CountDownLatch(1);
        AtomicReference<Thread> owner = new AtomicReference<>();
        when(blocked.clonePath()).thenAnswer(call -> {
            // The real ParseAhead worker is stopped before opening its source; no lock implementation is inspected.
            if (Thread.currentThread() != owner.get()) {
                parserEntered.countDown();
                releaseParser.await();
            }
            return original.clonePath();
        });
        CompletableFuture<AnalysisResult> firstResult = new CompletableFuture<>();
        Thread first = Thread.ofVirtual().unstarted(() -> {
            try {
                firstResult.complete(analyzer.analyze(blocked));
            } catch (Throwable failure) {
                firstResult.completeExceptionally(failure);
            }
        });
        owner.set(first);
        record Cancelled(Throwable failure, boolean interrupted) {}
        CompletableFuture<Cancelled> secondResult = new CompletableFuture<>();
        CountDownLatch secondStarted = new CountDownLatch(1);
        AnalysisContext secondContext = new AnalysisContext(2, 3, original.clonePath(), original.inventory());
        var secondInput = dev.codeintelligence.analysis.core.AnalysisInputFingerprint.capture(secondContext);
        Thread second = Thread.ofVirtual().unstarted(() -> {
            secondStarted.countDown();
            try {
                if (analyzer instanceof JavaAnalyzer java) java.analyze(secondContext, secondInput);
                else ((JavaFrameworkAnalyzer) analyzer).analyze(secondContext, secondInput);
                secondResult.complete(new Cancelled(null, Thread.currentThread().isInterrupted()));
            } catch (Throwable failure) {
                secondResult.complete(
                        new Cancelled(failure, Thread.currentThread().isInterrupted()));
            }
        });
        first.start();
        try {
            assertThat(parserEntered.await(10, TimeUnit.SECONDS)).isTrue();
            second.start();
            assertThat(secondStarted.await(10, TimeUnit.SECONDS)).isTrue();
            awaitQueued(second);
            second.interrupt();
            Cancelled cancelled = secondResult.get(5, TimeUnit.SECONDS);
            assertThat(cancelled.failure()).isInstanceOf(JobCancelledException.class);
            assertThat(cancelled.interrupted()).isTrue();
            assertThat(firstResult.isDone()).isFalse();
        } finally {
            releaseParser.countDown();
            first.join(10_000);
            second.join(10_000);
        }
        AnalysisResult completed = firstResult.get(10, TimeUnit.SECONDS);
        CodeAnalyzer independent = analyzer instanceof JavaAnalyzer ? new JavaAnalyzer(0) : new JavaFrameworkAnalyzer();
        assertThat(completed).isEqualTo(independent.analyze(original));
        assertThat(analyzer.analyze(original)).isEqualTo(completed);
        System.out.println("QUEUED_CANCEL analyzer=" + analyzer.getClass().getSimpleName()
                + " cancelledBeforeParserRelease=true interruptPreserved=true firstSucceeded=true equality=true");
    }

    private static void awaitQueued(Thread worker) throws InterruptedException {
        // Coordinate the interrupt after the second call is waiting, not before method entry.
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (worker.getState() != Thread.State.WAITING && worker.getState() != Thread.State.BLOCKED) {
            if (System.nanoTime() >= deadline) throw new AssertionError("second analysis did not queue");
            Thread.sleep(1);
        }
    }
}
