package dev.codeintelligence.analysis.accuracy;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.accuracy.SemanticOracle.Fact;
import dev.codeintelligence.analysis.config.ExtractionStep;
import dev.codeintelligence.analysis.core.FileInventoryStep;
import dev.codeintelligence.analysis.cross.CrossDomainStep;
import dev.codeintelligence.analysis.feature.FeatureDetectionStep;
import dev.codeintelligence.analysis.finding.FindingDetectionStep;
import dev.codeintelligence.analysis.graph.GraphBuildStep;
import dev.codeintelligence.analysis.graph.SourceParsingStep;
import dev.codeintelligence.analysis.ts.TsParsingStep;
import dev.codeintelligence.testsupport.FakeTsAnalyzer;
import dev.codeintelligence.testsupport.FixtureRepo;
import dev.codeintelligence.testsupport.TestJobContext;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

@SpringBootTest(
        properties = {"app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", "logging.level.root=WARN"})
@Import(TestcontainersConfiguration.class)
class FixtureAccuracyTest {
    // Normal backend tests reuse the existing fake. ./accuracy-gate supplies the real local sidecar.
    private static final FakeTsAnalyzer fake = new FakeTsAnalyzer();

    @TempDir
    static Path dataDir;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> dataDir.toString());
        registry.add("app.ts-analyzer.base-url", () -> System.getProperty("accuracy.ts-url", fake.baseUrl()));
    }

    @AfterAll
    static void closeFake() {
        fake.close();
    }

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    FileInventoryStep inventory;

    @Autowired
    SourceParsingStep source;

    @Autowired
    GraphBuildStep graph;

    @Autowired
    TsParsingStep ts;

    @Autowired
    ExtractionStep extraction;

    @Autowired
    CrossDomainStep cross;

    @Autowired
    FeatureDetectionStep features;

    @Autowired
    FindingDetectionStep findings;

    @ParameterizedTest(name = "{0}: exact natural keys, semantic edges and false positives")
    @ValueSource(strings = {"spring-mini", "react-mini", "fullstack-mini"})
    void matchesReviewedOracleAcrossFreshSnapshotsAndReruns(String fixture) throws Exception {
        for (int attempt = 0; attempt < 2; attempt++) {
            TestJobContext ctx = seed(fixture);
            analyze(ctx);
            verify(fixture, ctx);
            // Persistence, extraction and feature/finding reruns must not hide duplicate facts.
            analyze(ctx);
            verify(fixture, ctx);
        }
        FixtureAccuracyOracle.SCOPE_NOTES.forEach(System.out::println);
    }

    @Test
    void fullstackTestDeclarationsCannotSeedOrJoinFeatures() throws Exception {
        TestJobContext ctx = seed("fullstack-mini");
        // Strengthen the existing test files in a temporary copy; production fixture files stay intact.
        Files.writeString(ctx.clonePath().resolve("frontend/src/components/TodoItem.test.tsx"), """
                import { Route } from 'react-router-dom';
                export function TestPreview() {
                  fetch('/api/todos');
                  return <Route path="/test-only" element={<TestPreview />} />;
                }
                """);
        Files.writeString(ctx.clonePath().resolve("backend/src/test/java/com/example/todo/TodoServiceTest.java"), """
                package com.example.todo;
                import org.springframework.web.bind.annotation.*;
                @RestController
                class TodoServiceTest {
                  @GetMapping("/test-only") public void preview() {}
                }
                """);
        analyze(ctx);
        SemanticOracle.verify(
                "fullstack-mini test declarations are not product features",
                FixtureAccuracyOracle.expected("fullstack-mini").stream()
                        .filter(f -> f.key().startsWith("feature"))
                        .toList(),
                AccuracyFacts.features(jdbc, ctx.snapshotId().orElseThrow()),
                List.of());
    }

    @Test
    void brokenFullstackFixtureStillReportsRealFindings() throws Exception {
        TestJobContext ctx = seed("fullstack-mini");
        replace(ctx, "frontend/src/App.tsx", "element={<HomePage />}", "element={<MissingPage />}");
        replace(ctx, "frontend/src/pages/TodosPage.tsx", "/api/todos", "/missing-api");
        replace(
                ctx,
                "backend/src/main/java/com/example/todo/domain/Todo.java",
                "name = \"todos\"",
                "name = \"missing_table\"");
        analyze(ctx);
        SemanticOracle.verify(
                "broken fullstack-mini positive finding controls",
                List.of(
                        new Fact("finding ORPHAN_ROUTE route:/", "LOW"),
                        new Fact(
                                "finding UNMATCHED_API_CALL component:frontend/src/pages/TodosPage.tsx#TodosPage",
                                "MEDIUM"),
                        new Fact("finding UNMAPPED_ENTITY entity:com.example.todo.domain.Todo", "LOW")),
                AccuracyFacts.findings(jdbc, ctx.snapshotId().orElseThrow()),
                List.of());
    }

    private void verify(String fixture, TestJobContext ctx) {
        SemanticOracle.verify(
                fixture,
                FixtureAccuracyOracle.expected(fixture),
                AccuracyFacts.read(jdbc, ctx.snapshotId().orElseThrow()),
                FixtureAccuracyOracle.ignored(fixture));
    }

    private void analyze(TestJobContext ctx) throws Exception {
        inventory.run(ctx);
        source.run(ctx);
        graph.run(ctx);
        ts.run(ctx);
        extraction.run(ctx);
        cross.run(ctx);
        features.run(ctx);
        findings.run(ctx);
    }

    private TestJobContext seed(String fixture) throws Exception {
        long user = jdbc.queryForObject(
                "insert into users (github_id, login) values (?, ?) returning id",
                Long.class,
                System.nanoTime(),
                "accuracy-" + System.nanoTime());
        long project = jdbc.queryForObject("""
                insert into projects (user_id, name, repo_owner, repo_name)
                values (?, ?, 'fixture', ?) returning id
                """, Long.class, user, fixture, fixture + "-" + System.nanoTime());
        Path clone = FixtureRepo.create(fixture, dataDir.resolve("repos").resolve(String.valueOf(project)));
        jdbc.update("update projects set clone_path = ? where id = ?", clone.toString(), project);
        long snapshot = jdbc.queryForObject("""
                insert into snapshots (project_id, commit_sha, status)
                values (?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ANALYZING') returning id
                """, Long.class, project);
        return new TestJobContext(1, project, snapshot, clone);
    }

    private static void replace(TestJobContext ctx, String path, String from, String to) throws Exception {
        Path file = ctx.clonePath().resolve(path);
        String text = Files.readString(file);
        if (!text.contains(from)) {
            throw new AssertionError("Fixture mutation no longer matches " + path + ": " + from);
        }
        Files.writeString(file, text.replace(from, to));
    }
}
