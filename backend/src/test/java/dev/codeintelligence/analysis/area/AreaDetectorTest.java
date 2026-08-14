package dev.codeintelligence.analysis.area;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.area.detector.AiMlAreaDetector;
import dev.codeintelligence.analysis.area.detector.BackendAreaDetector;
import dev.codeintelligence.analysis.area.detector.BuildToolingAreaDetector;
import dev.codeintelligence.analysis.area.detector.DatabaseAreaDetector;
import dev.codeintelligence.analysis.area.detector.DevOpsAreaDetector;
import dev.codeintelligence.analysis.area.detector.DocumentationAreaDetector;
import dev.codeintelligence.analysis.area.detector.FrontendAreaDetector;
import dev.codeintelligence.analysis.area.detector.InfrastructureAreaDetector;
import dev.codeintelligence.analysis.area.detector.MobileAreaDetector;
import dev.codeintelligence.analysis.area.detector.OtherAreaDetector;
import dev.codeintelligence.analysis.area.detector.SecurityAreaDetector;
import dev.codeintelligence.analysis.area.detector.TestingAreaDetector;
import dev.codeintelligence.analysis.core.DetectionContext;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class AreaDetectorTest {

    @Test
    void backendDetectsSpringBoot() {
        DetectionContext ctx = DetectionContext.of(
                List.of("build.gradle", "src/main/java/Foo.java"),
                "org.springframework.boot:spring-boot-starter-web",
                Map.of("src/main/java/Foo.java", "@RestController class Foo {}"));
        assertThat(new BackendAreaDetector().detect(ctx)).isNotEmpty();
    }

    @Test
    void frontendDetectsReact() {
        DetectionContext ctx = DetectionContext.of(
                List.of("package.json", "src/App.tsx", "index.html", "vite.config.ts"),
                "\"react\": \"^18\" vite",
                Map.of());
        assertThat(new FrontendAreaDetector().detect(ctx)).isNotEmpty();
    }

    @Test
    void mobileDetectsAndroidDir() {
        DetectionContext ctx = DetectionContext.of(List.of("android/app/build.gradle"), "", Map.of());
        assertThat(new MobileAreaDetector().detect(ctx)).isNotEmpty();
    }

    @Test
    void databaseDetectsMigration() {
        DetectionContext ctx = DetectionContext.of(
                List.of("src/main/resources/db/migration/V1.sql", "src/main/java/Todo.java"),
                "flyway",
                Map.of("src/main/java/Todo.java", "@Entity class Todo {}"));
        assertThat(new DatabaseAreaDetector().detect(ctx)).isNotEmpty();
    }

    @Test
    void infrastructureDetectsDockerfile() {
        DetectionContext ctx = DetectionContext.of(List.of("Dockerfile", "docker-compose.yml"), "", Map.of());
        assertThat(new InfrastructureAreaDetector().detect(ctx)).isNotEmpty();
    }

    @Test
    void devopsDetectsGithubWorkflow() {
        DetectionContext ctx = DetectionContext.of(List.of(".github/workflows/ci.yml"), "", Map.of());
        assertThat(new DevOpsAreaDetector().detect(ctx)).isNotEmpty();
    }

    @Test
    void securityDetectsSpringSecurity() {
        DetectionContext ctx = DetectionContext.of(
                List.of("build.gradle", "src/main/java/auth/AuthFilter.java"),
                "spring-boot-starter-security",
                Map.of());
        assertThat(new SecurityAreaDetector().detect(ctx)).isNotEmpty();
    }

    @Test
    void testingDetectsSrcTest() {
        DetectionContext ctx = DetectionContext.of(List.of("src/test/java/FooTest.java"), "junit", Map.of());
        assertThat(new TestingAreaDetector().detect(ctx)).isNotEmpty();
    }

    @Test
    void aiMlDetectsOpenai() {
        DetectionContext ctx = DetectionContext.of(List.of("package.json"), "\"openai\": \"1.0.0\"", Map.of());
        assertThat(new AiMlAreaDetector().detect(ctx)).isNotEmpty();
    }

    @Test
    void documentationDetectsDocsDir() {
        DetectionContext ctx = DetectionContext.of(List.of("docs/intro.md"), "", Map.of());
        assertThat(new DocumentationAreaDetector().detect(ctx)).isNotEmpty();
    }

    @Test
    void buildToolingDetectsGradle() {
        DetectionContext ctx = DetectionContext.of(List.of("build.gradle"), "", Map.of());
        assertThat(new BuildToolingAreaDetector().detect(ctx)).isNotEmpty();
    }

    @Test
    void otherDetectsUnclaimedCluster() {
        DetectionContext ctx = DetectionContext.of(List.of("misc/a.txt", "misc/b.txt", "misc/c.txt"), "", Map.of());
        assertThat(new OtherAreaDetector().detect(ctx)).isNotEmpty();
    }

    @Test
    void emptyRepoYieldsNoAreas() {
        AreaDetectionEngine engine = new AreaDetectionEngine(List.of(
                new BackendAreaDetector(),
                new FrontendAreaDetector(),
                new MobileAreaDetector(),
                new DatabaseAreaDetector(),
                new InfrastructureAreaDetector(),
                new DevOpsAreaDetector(),
                new SecurityAreaDetector(),
                new TestingAreaDetector(),
                new AiMlAreaDetector(),
                new DocumentationAreaDetector(),
                new BuildToolingAreaDetector(),
                new OtherAreaDetector()));
        assertThat(engine.detect(DetectionContext.of(List.of(), "", Map.of()))).isEmpty();
    }

    @Test
    void confidenceIsCappedSumOfWeights() {
        AreaDetectionEngine engine = new AreaDetectionEngine(List.of(ctx -> List.of(
                new AreaSignal(AreaType.BACKEND, "A", 0.7, EvidenceRef.config("a", "a")),
                new AreaSignal(AreaType.BACKEND, "B", 0.7, EvidenceRef.config("b", "b")))));
        assertThat(engine.detect(DetectionContext.of(List.of("a", "b"), "", Map.of())))
                .singleElement()
                .extracting(DetectedArea::confidence)
                .isEqualTo(1.0);
    }
}
