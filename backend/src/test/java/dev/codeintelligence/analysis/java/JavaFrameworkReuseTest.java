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
    @TempDir Path root;

    @Test
    void productBeansShareOneParseAndReuseUnchangedFile() throws Exception {
        Files.writeString(root.resolve("A.java"), "@Entity @Service class A { @KafkaListener(topics=\"events\") void run() {} }");
        AnalysisContext context = new AnalysisContext(1, 1, root,
                FileInventory.of(new InventoriedFile("A.java", "java", 0, 1, "")));
        try (var spring = new AnnotationConfigApplicationContext("dev.codeintelligence.analysis.java")) {
            List<CodeAnalyzer> analyzers = spring.getBeansOfType(CodeAnalyzer.class).values().stream()
                    .filter(analyzer -> !(analyzer instanceof JavaAnalyzer)).toList();
            long before = JavaParseSupport.PARSER_INVOCATIONS.get();
            for (CodeAnalyzer analyzer : analyzers) analyzer.analyze(context);
            assertThat(JavaParseSupport.PARSER_INVOCATIONS.get() - before).isEqualTo(1);
            for (CodeAnalyzer analyzer : analyzers) analyzer.analyze(context);
            assertThat(JavaParseSupport.PARSER_INVOCATIONS.get() - before).isEqualTo(1);
        }
    }
}
