package dev.codeintelligence.analysis.java;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisInputFingerprint;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.job.JobCancelledException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.junit.jupiter.api.io.TempDir;

class JavaIncrementalTest {
    @TempDir Path root;

    @Test
    void unchangedRefreshReusesCompletedResult() throws Exception {
        write(root, "A.java", "class A { int value() { return 1; } }");
        JavaAnalyzer analyzer = new JavaAnalyzer();
        AnalysisResult first = analyzer.analyze(context(root));
        assertThat(analyzer.analyze(context(root))).isSameAs(first);
        assertThat(analyzer.cacheStats().parserInvocations()).isZero();
    }

    @Test
    void bodyEditReusesUnchangedDeclarationsAndMatchesIndependentFull() throws Exception {
        write(root, "A.java", "class A { int value() { return 1; } }");
        write(root, "B.java", "class B { int use() { return new A().value(); } }");
        JavaAnalyzer analyzer = new JavaAnalyzer();
        AnalysisResult first = analyzer.analyze(context(root));
        write(root, "A.java", "class A { int value() { return 2; } }");
        AnalysisResult changed = analyzer.analyze(context(root));
        assertThat(analyzer.cacheStats().parserInvocations()).isEqualTo(3);
        assertThat(analyzer.cacheStats().reusedPhases()).isEqualTo(3);
        assertThat(changed).isEqualTo(new JavaAnalyzer(0).analyze(context(root)));
        var original = first.nodes().stream().filter(node -> node.naturalKey().equals("java:B")).findFirst().orElseThrow();
        assertThat(changed.nodes().stream().filter(node -> node.naturalKey().equals("java:B")).findFirst().orElseThrow())
                .isSameAs(original);
    }

    @Test
    void jobWorkspaceRelocationAndGitMetadataDoNotInvalidateSourceResults() throws Exception {
        Path one = Files.createDirectory(root.resolve("one"));
        Path two = Files.createDirectory(root.resolve("two"));
        String source = "class A { void call() { other(); } void other() {} }";
        write(one, "A.java", source);
        write(two, "A.java", source);
        write(one, ".git/HEAD", "old metadata");
        write(two, ".git/HEAD", "new metadata");
        JavaAnalyzer analyzer = new JavaAnalyzer();
        AnalysisResult first = analyzer.analyze(context(one));
        assertThat(analyzer.analyze(context(two))).isSameAs(first);
        assertThat(analyzer.cacheStats().parserInvocations()).isZero();
        write(two, "A.java", "class A { void call() { changed(); } void other() {} void changed() {} }");
        assertThat(analyzer.analyze(context(two))).isEqualTo(new JavaAnalyzer(0).analyze(context(two)));
    }

    @Test
    void cacheBudgetFallbackAndUnknownFilesystemDependenciesStayCorrect() throws Exception {
        write(root, "A.java", "class A { void call() { other(); } void other() {} }");
        JavaAnalyzer bounded = new JavaAnalyzer(1);
        AnalysisResult first = bounded.analyze(context(root));
        assertThat(bounded.cacheStats().retainedBytes()).isZero();
        assertThat(bounded.analyze(context(root))).isEqualTo(first).isNotSameAs(first);
        assertThat(bounded.cacheStats().parserInvocations()).isEqualTo(3);
        Files.createSymbolicLink(root.resolve("alias.txt"), Path.of("A.java"));
        JavaAnalyzer unknown = new JavaAnalyzer();
        assertThat(AnalysisInputFingerprint.capture(context(root))).isNull();
        AnalysisResult result = unknown.analyze(context(root));
        assertThat(unknown.analyze(context(root))).isEqualTo(result).isNotSameAs(result);
        assertThat(unknown.cacheStats().retainedBytes()).isZero();
    }

    @Test
    void cancelledCacheHitDoesNotPublishOrDiscardTheLastCompletedGeneration() throws Exception {
        write(root, "A.java", "class A {}");
        JavaAnalyzer analyzer = new JavaAnalyzer();
        AnalysisContext context = context(root);
        AnalysisResult first = analyzer.analyze(context);
        Thread.currentThread().interrupt();
        try { assertThatThrownBy(() -> analyzer.analyze(context)).isInstanceOf(JobCancelledException.class); }
        finally { Thread.interrupted(); }
        assertThat(analyzer.analyze(context)).isSameAs(first);
    }

    @TestFactory
    Stream<DynamicTest> mutationsMatchIndependentCleanFullGraphsEvidenceAndOutcomes() {
        String a = "package p; public class A { public void call() {} }";
        String b = "package p; class B { void run() { new A().call(); } }";
        Map<String, String> base = Map.of("src/main/java/p/A.java", a, "src/main/java/p/B.java", b);
        record Case(String name, Map<String, String> before, Map<String, String> after) {}
        List<Case> cases = List.of(
                new Case("same-size-callee", Map.of("A.java", "class A { void run(){ one(); } void one(){} void two(){} }"),
                        Map.of("A.java", "class A { void run(){ two(); } void one(){} void two(){} }")),
                new Case("body-lines", base, Map.of("src/main/java/p/A.java", a.replace("call() {}", "call() {\n int x = 3;\n System.out.println(x);\n }"), "src/main/java/p/B.java", b)),
                new Case("signature", base, Map.of("src/main/java/p/A.java", a.replace("call()", "call(int x)"), "src/main/java/p/B.java", b)),
                new Case("type-signature", base, Map.of("src/main/java/p/A.java", a.replace("class A", "class C"), "src/main/java/p/B.java", b)),
                new Case("dependency-delete", base, Map.of("src/main/java/p/B.java", b)),
                new Case("rename-module", base, Map.of("module/src/main/java/p/A.java", a, "src/main/java/p/B.java", b)),
                new Case("unresolved-to-resolved", Map.of("src/main/java/p/B.java", b), base),
                new Case("duplicate-identity", base, Map.of("src/main/java/p/A.java", a, "src/main/java/p/B.java", b, "module/src/main/java/p/A.java", a)),
                new Case("overload", base, Map.of("src/main/java/p/A.java", a.replace("call() {}", "call() {} public void call(String s) {}"), "src/main/java/p/B.java", b)),
                new Case("hierarchy", Map.of("Types.java", "interface I { void run(); } class A implements I { public void run(){} } class B { void call(I i){ i.run(); } }"),
                        Map.of("Types.java", "interface I { void run(); } class A implements I { public void run(){} } class C implements I { public void run(){} } class B { void call(I i){ i.run(); } }")),
                new Case("config", Map.of("A.java", "class A {}", "pom.xml", "<project><name>one</name></project>"),
                        Map.of("A.java", "class A {}", "pom.xml", "<project><name>two</name></project>")),
                new Case("module-contract", Map.of("A.java", "class A {}", "module-info.java", "module first {}"),
                        Map.of("A.java", "class A {}", "module-info.java", "module second {}")),
                new Case("parse-failure-repair", Map.of("A.java", "class A {", "B.java", "class B { void run(){ new A().call(); } }"),
                        Map.of("A.java", "class A { void call(){} }", "B.java", "class B { void run(){ new A().call(); } }")),
                new Case("global-unresolved-candidates", Map.of("A.java", "class A { void foo(){} void run(){ unknown.foo(); } }", "B.java", "class B { void run(){ missing.foo(); } }"),
                        Map.of("A.java", "class A { void foo(){} void run(){ unknown.bar(); } }", "B.java", "class B { void run(){ missing.foo(); } }")));
        return cases.stream().map(test -> DynamicTest.dynamicTest(test.name, () -> {
            Path tree = Files.createDirectory(root.resolve(test.name));
            for (var file : test.before.entrySet()) write(tree, file.getKey(), file.getValue());
            JavaAnalyzer incremental = new JavaAnalyzer();
            AnalysisResult before = incremental.analyze(context(tree));
            assertThat(before).isEqualTo(new JavaAnalyzer(0).analyze(context(tree)));
            for (String path : test.before.keySet()) if (!test.after.containsKey(path)) Files.delete(tree.resolve(path));
            for (var file : test.after.entrySet()) write(tree, file.getKey(), file.getValue());
            AnalysisResult after = incremental.analyze(context(tree));
            assertThat(after).isEqualTo(new JavaAnalyzer(0).analyze(context(tree)));
            assertThat(incremental.analyze(context(tree))).isEqualTo(after);
            assertThat(incremental.cacheStats().retainedBytes()).isLessThanOrEqualTo(JavaAnalyzer.MAX_CACHE_BYTES);
        }));
    }

    static void write(Path tree, String path, String source) throws Exception {
        Files.createDirectories(tree.resolve(path).getParent());
        Files.writeString(tree.resolve(path), source);
    }

    static AnalysisContext context(Path tree) throws Exception {
        try (var paths = Files.walk(tree)) {
            List<InventoriedFile> files = paths.filter(Files::isRegularFile)
                    .filter(path -> !AnalysisInputFingerprint.isMetadata(tree.relativize(path))).sorted().map(path -> {
                try {
                    String relative = tree.relativize(path).toString().replace('\\', '/');
                    return new InventoriedFile(relative, relative.endsWith(".java") ? "java" : "text", Files.size(path), 1, "");
                } catch (Exception failure) { throw new IllegalStateException(failure); }
            }).toList();
            return new AnalysisContext(1, 2, tree, FileInventory.of(files));
        }
    }
}
