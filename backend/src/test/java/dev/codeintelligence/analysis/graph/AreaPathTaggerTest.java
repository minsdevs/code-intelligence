package dev.codeintelligence.analysis.graph;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class AreaPathTaggerTest {

    @Test
    void tagsByPathConvention() {
        assertThat(AreaPathTagger.tag("src/test/java/com/example/todo/TodoServiceTest.java"))
                .isEqualTo("TESTING");
        assertThat(AreaPathTagger.tag("src/main/java/com/example/todo/api/TodoController.java"))
                .isEqualTo("BACKEND");
        assertThat(AreaPathTagger.tag("src/main/resources/db/migration/V1__create_todos.sql"))
                .isEqualTo("DATABASE");
        assertThat(AreaPathTagger.tag(".github/workflows/ci.yml")).isEqualTo("DEVOPS");
        assertThat(AreaPathTagger.tag("docker-compose.yml")).isEqualTo("INFRASTRUCTURE");
        assertThat(AreaPathTagger.tag("README.md")).isEqualTo("DOCUMENTATION");
        assertThat(AreaPathTagger.tag("build.gradle")).isEqualTo("BUILD_TOOLING");
        assertThat(AreaPathTagger.tag("src/pages/TodosPage.tsx")).isEqualTo("FRONTEND");
        assertThat(AreaPathTagger.tag("frontend/src/App.tsx")).isEqualTo("FRONTEND");
    }
}
