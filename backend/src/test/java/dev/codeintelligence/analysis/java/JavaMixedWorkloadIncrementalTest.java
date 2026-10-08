package dev.codeintelligence.analysis.java;

import static dev.codeintelligence.analysis.java.JavaIncrementalTest.context;
import static dev.codeintelligence.analysis.java.JavaIncrementalTest.write;
import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.AnalysisInputFingerprint;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class JavaMixedWorkloadIncrementalTest {
    @TempDir Path root;

    @Test
    void ordinaryFieldInitializersCommentsAndForeignSourceEditsDoNotInvalidateOtherJavaFiles() throws Exception {
        write(root, "A.java", "class A { static final int COUNT = 11; Object value = new Object(); int count(){ return COUNT; } }");
        write(root, "B.java", "class B { int use(){ return new A().count(); } }");
        write(root, "app.ts", "export const value = 11;");
        JavaAnalyzer analyzer = new JavaAnalyzer();
        JavaFrameworkAnalyzer frameworks = new JavaFrameworkAnalyzer();
        analyzer.analyze(context(root));
        frameworks.analyze(context(root));
        write(root, "A.java", "// comment\nclass A { static final int COUNT = 19; Object value = new String(); int count(){ return COUNT; } }");
        write(root, "app.ts", "export const value = 19;");
        var actual = analyzer.analyze(context(root));
        assertThat(actual).isEqualTo(new JavaAnalyzer(0).analyze(context(root)));
        assertThat(analyzer.cacheStats().parserInvocations()).isEqualTo(3);
        long before = JavaParseSupport.PARSER_INVOCATIONS.get();
        var frameworkResult = frameworks.analyze(context(root));
        assertThat(JavaParseSupport.PARSER_INVOCATIONS.get() - before).isEqualTo(1);
        assertThat(frameworkResult).isEqualTo(new JavaFrameworkAnalyzer().analyze(context(root)));
    }

    @Test
    void byteBoundRatherThanAnArbitraryFileCountControlsRetention() throws Exception {
        for (int i = 0; i < 4097; i++) write(root, "C" + i + ".java", "class C" + i + " {}");
        JavaAnalyzer analyzer = new JavaAnalyzer();
        JavaFrameworkAnalyzer frameworks = new JavaFrameworkAnalyzer();
        var first = analyzer.analyze(context(root));
        frameworks.analyze(context(root));
        assertThat(analyzer.analyze(context(root))).isEqualTo(first);
        assertThat(analyzer.cacheStats().parserInvocations()).isZero();
        assertThat(analyzer.cacheStats().retainedBytes()).isLessThanOrEqualTo(64L * 1024 * 1024);
        long before = JavaParseSupport.PARSER_INVOCATIONS.get();
        frameworks.analyze(context(root));
        assertThat(JavaParseSupport.PARSER_INVOCATIONS.get() - before).isZero();
    }

    @Test
    void actualMixedWorkloadOnePercentMutationMatchesIndependentFull() throws Exception {
        Path workspace = Files.createTempDirectory(root, "mixed-").toRealPath();
        Path manifest = root.resolve("manifest.json");
        Path generator = Path.of("../validation/pre-release/workload-fixture.cjs").toAbsolutePath().normalize();
        node("const f=require(process.argv[1]),fs=require('fs'); fs.writeFileSync(process.argv[3],JSON.stringify(f.generateWorkload({root:process.argv[2],files:1000,bytes:2097152})));", generator, workspace, manifest);
        JavaAnalyzer analyzer = new JavaAnalyzer();
        JavaFrameworkAnalyzer frameworks = new JavaFrameworkAnalyzer();
        var before = AnalysisInputFingerprint.capture(context(workspace));
        analyzer.analyze(context(workspace));
        frameworks.analyze(context(workspace));
        node("const f=require(process.argv[1]),fs=require('fs'); console.log(JSON.stringify(f.mutateWorkload({root:process.argv[2],manifest:JSON.parse(fs.readFileSync(process.argv[3],'utf8'))})));", generator, workspace, manifest);
        var after = AnalysisInputFingerprint.capture(context(workspace));
        long changedJava = before.files().entrySet().stream().filter(entry -> !entry.getValue().equals(after.files().get(entry.getKey()))).count();
        assertThat(changedJava).isPositive().isLessThan(10);
        var changed = analyzer.analyze(context(workspace));
        var stats = analyzer.cacheStats();
        assertThat(changed).isEqualTo(new JavaAnalyzer(0).analyze(context(workspace)));
        assertThat(stats.parserInvocations()).isEqualTo(3 * changedJava);
        assertThat(stats.reusedPhases()).isEqualTo(3 * (before.files().size() - changedJava));
        long parses = JavaParseSupport.PARSER_INVOCATIONS.get();
        var frameworkResult = frameworks.analyze(context(workspace));
        assertThat(JavaParseSupport.PARSER_INVOCATIONS.get() - parses).isEqualTo(changedJava);
        assertThat(frameworkResult).isEqualTo(new JavaFrameworkAnalyzer().analyze(context(workspace)));
        System.out.printf("JAVA_MIXED_WORKLOAD files=1000 bytes=2097152 changedFiles=10 javaFiles=%d changedJava=%d parserInvocations=%d reusedPhases=%d retainedBytes=%d equality=true%n", before.files().size(), changedJava, stats.parserInvocations(), stats.reusedPhases(), stats.retainedBytes());
    }

    private static void node(String script, Path generator, Path workspace, Path manifest) throws Exception {
        Process process = new ProcessBuilder("node", "-e", script, generator.toString(), workspace.toString(), manifest.toString()).redirectErrorStream(true).start();
        String output = new String(process.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        assertThat(process.waitFor()).as(output).isZero();
        System.out.print(output);
    }
}
