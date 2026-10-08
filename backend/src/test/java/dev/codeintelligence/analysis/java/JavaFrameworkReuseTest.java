package dev.codeintelligence.analysis.java;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;

class JavaFrameworkReuseTest {
    @TempDir
    Path root;

    @Test
    void productBeansShareOneParseAndReuseUnchangedFile() throws Exception {
        Files.writeString(
                root.resolve("A.java"), "@Entity @Service class A { @KafkaListener(topics=\"events\") void run() {} }");
        AnalysisContext context =
                new AnalysisContext(1, 1, root, FileInventory.of(new InventoriedFile("A.java", "java", 0, 1, "")));
        try (var spring = new AnnotationConfigApplicationContext("dev.codeintelligence.analysis.java")) {
            List<CodeAnalyzer> analyzers = spring.getBeansOfType(CodeAnalyzer.class).values().stream()
                    .filter(analyzer -> !(analyzer instanceof JavaAnalyzer))
                    .toList();
            long before = JavaParseSupport.PARSER_INVOCATIONS.get();
            for (CodeAnalyzer analyzer : analyzers) analyzer.analyze(context);
            assertThat(JavaParseSupport.PARSER_INVOCATIONS.get() - before).isEqualTo(1);
            for (CodeAnalyzer analyzer : analyzers) analyzer.analyze(context);
            assertThat(JavaParseSupport.PARSER_INVOCATIONS.get() - before).isEqualTo(1);
        }
    }

    @Test
    void sharedVisitorsRemainReadOnlyAndIncrementalResultsEqualFourIndependentWalks() throws Exception {
        String a =
                "@Entity @Service class A { @KafkaListener(topics=\"events\") void run(){ kafka.send(\"events\", 1); } }";
        String b =
                "@RestController @RequestMapping(\"/api\") class B { @GetMapping(\"/items\") void list(){} @KafkaListener(topics=\"events\") void consume(){} }";
        JavaIncrementalTest.write(root, "A.java", a);
        JavaIncrementalTest.write(root, "B.java", b);
        JavaFrameworkAnalyzer analyzer = new JavaFrameworkAnalyzer();
        assertThat(analyzer.analyze(JavaIncrementalTest.context(root)))
                .isEqualTo(independent(JavaIncrementalTest.context(root)));
        JavaIncrementalTest.write(root, "A.java", a.replace("events", "orders"));
        long before = JavaParseSupport.PARSER_INVOCATIONS.get();
        AnalysisResult changed = analyzer.analyze(JavaIncrementalTest.context(root));
        assertThat(JavaParseSupport.PARSER_INVOCATIONS.get() - before).isEqualTo(1);
        assertThat(changed).isEqualTo(independent(JavaIncrementalTest.context(root)));
        Files.move(root.resolve("B.java"), root.resolve("Renamed.java"));
        assertThat(analyzer.analyze(JavaIncrementalTest.context(root)))
                .isEqualTo(independent(JavaIncrementalTest.context(root)));
        Files.delete(root.resolve("A.java"));
        assertThat(analyzer.analyze(JavaIncrementalTest.context(root)))
                .isEqualTo(independent(JavaIncrementalTest.context(root)));
        JavaIncrementalTest.write(root, "Broken.java", "class Broken {");
        assertThat(analyzer.analyze(JavaIncrementalTest.context(root)))
                .isEqualTo(independent(JavaIncrementalTest.context(root)));
        for (var unit : JavaParseSupport.parseJavaFiles(JavaIncrementalTest.context(root))) {
            String original = unit.cu().toString();
            var single = List.of(unit);
            new JpaEntityExtractor().analyzeFiles(single);
            new KafkaEventExtractor().analyzeFiles(single);
            new LayerTagger().analyzeFiles(single);
            new SpringEndpointExtractor().analyzeFiles(single);
            assertThat(unit.cu().toString()).isEqualTo(original);
        }
    }

    @Test
    void emptyInventoryAndCancelledRefreshDoNotPublishPartialCache() throws Exception {
        JavaFrameworkAnalyzer analyzer = new JavaFrameworkAnalyzer();
        AnalysisContext empty = new AnalysisContext(1, 1, root, FileInventory.of(List.of()));
        assertThat(analyzer.analyze(empty)).isEqualTo(AnalysisResult.EMPTY);
        Thread.currentThread().interrupt();
        try {
            org.assertj.core.api.Assertions.assertThatThrownBy(() -> analyzer.analyze(empty))
                    .isInstanceOf(dev.codeintelligence.job.JobCancelledException.class);
        } finally {
            Thread.interrupted();
        }
        assertThat(analyzer.analyze(empty)).isEqualTo(AnalysisResult.EMPTY);
    }

    private AnalysisResult independent(AnalysisContext context) {
        var nodes = new java.util.ArrayList<GraphNodeDraft>();
        var edges = new java.util.ArrayList<GraphEdgeDraft>();
        var evidences = new java.util.ArrayList<AnalyzerEvidence>();
        for (CodeAnalyzer visitor : List.of(
                new JpaEntityExtractor(),
                new KafkaEventExtractor(),
                new LayerTagger(),
                new SpringEndpointExtractor())) {
            AnalysisResult result = visitor.analyze(context);
            nodes.addAll(result.nodes());
            edges.addAll(result.edges());
            evidences.addAll(result.evidences());
        }
        return new AnalysisResult(nodes, edges, evidences);
    }
}
