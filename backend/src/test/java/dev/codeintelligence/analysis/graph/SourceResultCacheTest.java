package dev.codeintelligence.analysis.graph;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.config.*;
import dev.codeintelligence.analysis.core.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SourceResultCacheTest {
    @TempDir Path root;

    @Test
    void allNineConfigAnalyzersReuseOnlyCompleteMatchingInputAndRetainCrossFileMeaning() throws Exception {
        Map<String, String> sources = Map.ofEntries(
                Map.entry("build.gradle", "dependencies {\n implementation 'org.example:library:1.0'\n}\n"),
                Map.entry("Dockerfile", "FROM alpine:3.20\nEXPOSE 8080\n"),
                Map.entry("compose.yaml", "services:\n  app:\n    build: .\n"),
                Map.entry(".github/workflows/ci.yml", "name: CI\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo local\n"),
                Map.entry("k8s/deployment.yaml", "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      containers:\n        - name: app\n          image: app:latest\n"),
                Map.entry("serverless.yml", "service: local\nprovider:\n  name: aws\nfunctions:\n  hello:\n    handler: handler.hello\n"),
                Map.entry("db/migration/V1__create.sql", "create table users(id bigint primary key);\n"),
                Map.entry("main.tf", "resource \"aws_s3_bucket\" \"data\" { bucket = \"local\" }\n"),
                Map.entry("vercel.json", "{\"framework\":\"nextjs\",\"regions\":[\"iad1\"]}"),
                Map.entry("application.yaml", "spring:\n  datasource:\n    url: jdbc:postgresql://localhost:5432/local\n"));
        for (var source : sources.entrySet()) {
            Files.createDirectories(root.resolve(source.getKey()).getParent());
            Files.writeString(root.resolve(source.getKey()), source.getValue());
        }
        List<CodeAnalyzer> analyzers = List.of(new BuildFileAnalyzer(), new DockerAnalyzer(), new GithubActionsAnalyzer(),
                new KubernetesAnalyzer(), new ServerlessAnalyzer(), new SqlMigrationAnalyzer(), new TerraformAnalyzer(),
                new VercelAnalyzer(), new YamlConfigAnalyzer());
        SourceResultCache cache = new SourceResultCache();
        AnalysisContext first = context();
        String key = AnalysisInputFingerprint.capture(first).complete();
        for (CodeAnalyzer analyzer : analyzers) {
            assertThat(analyzer.supports(first.inventory())).as(analyzer.getClass().getSimpleName()).isTrue();
            AnalysisResult result = cache.analyze(analyzer, first, key);
            assertThat(result).isEqualTo(analyzer.analyze(first));
            assertThat(cache.analyze(analyzer, first, key)).isSameAs(result);
        }
        Files.writeString(root.resolve("Dockerfile"), "FROM alpine:3.21\nEXPOSE 9090\n");
        Files.writeString(root.resolve("db/migration/V2__alter.sql"), "alter table users add column name text;\n");
        AnalysisContext changed = context();
        String changedKey = AnalysisInputFingerprint.capture(changed).complete();
        assertThat(changedKey).isNotEqualTo(key);
        for (CodeAnalyzer analyzer : analyzers)
            assertThat(cache.analyze(analyzer, changed, changedKey)).isEqualTo(analyzer.analyze(changed));
    }

    @Test
    void unknownAnalyzersAreNotAssumedDeterministic() {
        AtomicInteger calls = new AtomicInteger();
        CodeAnalyzer unknown = new CodeAnalyzer() {
            public boolean supports(FileInventory inventory) { return true; }
            public AnalysisResult analyze(AnalysisContext context) { calls.incrementAndGet(); return AnalysisResult.EMPTY; }
        };
        SourceResultCache cache = new SourceResultCache();
        AnalysisContext context = new AnalysisContext(1, 1, root, FileInventory.of(List.of()));
        cache.analyze(unknown, context, "same");
        cache.analyze(unknown, context, "same");
        assertThat(calls).hasValue(2);
    }

    private AnalysisContext context() throws Exception {
        try (var paths = Files.walk(root)) {
            List<InventoriedFile> files = paths.filter(Files::isRegularFile).sorted()
                    .map(path -> new InventoriedFile(root.relativize(path).toString().replace('\\', '/'), "text", 0, 1, "")).toList();
            return new AnalysisContext(1, 1, root, FileInventory.of(files));
        }
    }
}
