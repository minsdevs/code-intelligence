package dev.codeintelligence.analysis.java;

import static dev.codeintelligence.analysis.java.JavaIncrementalTest.context;
import static dev.codeintelligence.analysis.java.JavaIncrementalTest.write;
import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.FileInventory;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class JavaSourceResolutionTest {
    @TempDir
    Path root;

    @Test
    void secondaryNestedAndInheritedTypesKeepTheirFullResolution() throws Exception {
        write(root, "src/main/java/p/Definitions.java", """
                package p;
                @interface Ann {}
                class Base {
                    static class Nested { int value() { return 7; } }
                    static int inherited() { return 1; }
                }
                class Child extends Base {}
                class Helper { static int call() { return 2; } }
                """);
        write(root, "src/main/java/p/Consumer.java", """
                package p;
                import static p.Child.inherited;
                @Ann class Consumer {
                    Child.Nested nested;
                    int run() { return nested.value() + Helper.call() + inherited(); }
                }
                """);
        AnalysisResult result = checkColdAndWarm(context(root));
        assertThat(result.edges()).anyMatch(edge -> "CALLS".equals(edge.edgeType())
                && edge.targetNaturalKey().contains("Helper#call("));
        write(root, "src/main/java/p/Definitions.java", """
                package p;
                @interface Ann {}
                class Base {
                    static class Nested { int value() { return 8; } }
                    static int inherited() { return 3; }
                }
                class Child extends Base {}
                class Helper { static int call() { return 4; } }
                class Added {}
                """);
        checkColdAndWarm(context(root));
    }

    @Test
    void sourceMissingFromInventoryStillParticipatesInSolverFallback() throws Exception {
        write(root, "src/main/java/p/Definitions.java", "package q; @interface Special {}");
        write(root, "src/main/java/p/Consumer.java", "package p; @Special class Consumer {}");
        AnalysisContext all = context(root);
        AnalysisContext partial = new AnalysisContext(all.projectId(), all.snapshotId(), all.clonePath(),
                FileInventory.of(all.inventory().files().stream()
                        .filter(file -> file.path().endsWith("Consumer.java")).toList()));
        JavaAnalyzer analyzer = new JavaAnalyzer();
        AnalysisResult result = analyzer.analyze(partial);
        assertThat(result).isEqualTo(full(partial));
        assertThat(analyzer.analyze(partial)).isEqualTo(result);
        assertThat(result.edges()).anyMatch(edge -> "ANNOTATED_BY".equals(edge.edgeType())
                && "java:q.Special".equals(edge.targetNaturalKey()));
        write(root, "src/main/java/p/Definitions.java", "package r; @interface Special {}");
        AnalysisResult changed = analyzer.analyze(partial);
        assertThat(changed).isEqualTo(full(partial));
        assertThat(changed.edges()).anyMatch(edge -> "ANNOTATED_BY".equals(edge.edgeType())
                && "java:r.Special".equals(edge.targetNaturalKey()));
    }

    @Test
    void failedDeclarationsAndTheirRepairKeepIndependentFullGraph() throws Exception {
        write(root, "src/main/java/p/Definitions.java", "package p; class Helper { int value( }");
        write(root, "src/main/java/p/Consumer.java", """
                package p;
                class Consumer { int run() { return new Helper().value(); } }
                """);
        JavaAnalyzer analyzer = new JavaAnalyzer();
        assertThat(analyzer.analyze(context(root))).isEqualTo(full(context(root)));
        write(root, "src/main/java/p/Definitions.java",
                "package p; class Helper { int value() { return 1; } }");
        assertThat(analyzer.analyze(context(root))).isEqualTo(full(context(root)));
    }

    @Test
    void localAnonymousAndExternalTypesKeepIndependentFullGraph() throws Exception {
        write(root, "Consumer.java", """
                import java.util.function.IntSupplier;
                import missing.library.Service;
                @Service class Consumer {
                    int run() {
                        class Local { int value() { return 3; } }
                        IntSupplier supplier = new IntSupplier() { public int getAsInt() { return 2; } };
                        return new Local().value() + supplier.getAsInt();
                    }
                }
                """);
        checkColdAndWarm(context(root));
    }

    @Test
    void mismatchedPackageDirectoryKeepsUnrestrictedSolverSemantics() throws Exception {
        write(root, "src/main/java/p/Definitions.java",
                "package q; class Helper { static int call() { return 2; } }");
        write(root, "src/main/java/p/Consumer.java",
                "package p; class Consumer { int run() { return Helper.call(); } }");
        checkColdAndWarm(context(root));
    }

    private static AnalysisResult checkColdAndWarm(AnalysisContext context) {
        JavaAnalyzer analyzer = new JavaAnalyzer();
        AnalysisResult expected = full(context);
        AnalysisResult cold = analyzer.analyze(context);
        assertThat(cold).isEqualTo(expected);
        assertThat(analyzer.analyze(context)).isEqualTo(expected);
        return cold;
    }

    private static AnalysisResult full(AnalysisContext context) {
        // No complete input/declaration index: retain the unrestricted source solver as an oracle.
        return new JavaAnalyzer(0).analyze(context, null);
    }
}
