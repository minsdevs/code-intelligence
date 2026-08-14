package dev.codeintelligence.analysis.core;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;

class NaturalKeysTest {

    @Test
    void formatsStableKeys() {
        assertThat(NaturalKeys.file("src/main/java/Foo.java")).isEqualTo("file:src/main/java/Foo.java");
        assertThat(NaturalKeys.javaType("com.example.todo.api.TodoController"))
                .isEqualTo("java:com.example.todo.api.TodoController");
        assertThat(NaturalKeys.javaMethod(
                        "com.example.todo.service.TodoService", "findById", List.of("java.lang.Long")))
                .isEqualTo("java:com.example.todo.service.TodoService#findById(java.lang.Long)");
        assertThat(NaturalKeys.javaField("com.example.todo.domain.Todo", "title"))
                .isEqualTo("java:com.example.todo.domain.Todo#title");
        assertThat(NaturalKeys.endpoint("post", "/todos")).isEqualTo("endpoint:POST:/todos");
        assertThat(NaturalKeys.entity("com.example.todo.domain.Todo")).isEqualTo("entity:com.example.todo.domain.Todo");
        assertThat(NaturalKeys.table("todos")).isEqualTo("table:todos");
        assertThat(NaturalKeys.container("backend")).isEqualTo("container:backend");
        assertThat(NaturalKeys.ci("ci.yml", "build")).isEqualTo("ci:ci.yml:build");
        assertThat(NaturalKeys.config("build.gradle")).isEqualTo("config:build.gradle");
        assertThat(NaturalKeys.migration("db/migration/V1__init.sql")).isEqualTo("migration:db/migration/V1__init.sql");
        assertThat(NaturalKeys.dependency("org.postgresql", "postgresql")).isEqualTo("dep:org.postgresql:postgresql");
    }
}
