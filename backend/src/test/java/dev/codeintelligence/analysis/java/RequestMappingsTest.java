package dev.codeintelligence.analysis.java;

import static org.assertj.core.api.Assertions.assertThat;

import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.body.MethodDeclaration;
import org.junit.jupiter.api.Test;

class RequestMappingsTest {

    @Test
    void joinsClassPrefixMethodPathAndKeepsPathVariables() {
        assertThat(RequestMappings.join("/todos", "")).isEqualTo("/todos");
        assertThat(RequestMappings.join("/todos", "/{id}")).isEqualTo("/todos/{id}");
        assertThat(RequestMappings.join("todos", "{id}")).isEqualTo("/todos/{id}");
    }

    @Test
    void collapsesDuplicateSlashesAndStripsTrailingSlash() {
        assertThat(RequestMappings.join("/api/", "/todos/")).isEqualTo("/api/todos");
        assertThat(RequestMappings.normalize("//auth//login")).isEqualTo("/auth/login");
        assertThat(RequestMappings.normalize("/")).isEqualTo("/");
    }

    @Test
    void mappingAnnotationMethods() {
        MethodDeclaration get = method("@GetMapping(\"/{id}\") Todo get() { return null; }");
        assertThat(RequestMappings.httpMethods(get.getAnnotation(0))).containsExactly("GET");
        assertThat(RequestMappings.paths(get.getAnnotation(0))).containsExactly("/{id}");

        MethodDeclaration post = method("@PostMapping void login() {}");
        assertThat(RequestMappings.httpMethods(post.getAnnotation(0))).containsExactly("POST");
        assertThat(RequestMappings.paths(post.getAnnotation(0))).containsExactly("");

        MethodDeclaration request = method("@RequestMapping(method = RequestMethod.PUT, path = \"/x\") void put() {}");
        assertThat(RequestMappings.httpMethods(request.getAnnotation(0))).containsExactly("PUT");
        assertThat(RequestMappings.paths(request.getAnnotation(0))).containsExactly("/x");
    }

    @Test
    void snakeCaseDefaultTableStrategy() {
        assertThat(RequestMappings.toSnakeCase("Todo")).isEqualTo("todo");
        assertThat(RequestMappings.toSnakeCase("OrderItem")).isEqualTo("order_item");
        assertThat(RequestMappings.toSnakeCase("HTTPRequest")).isEqualTo("http_request");
    }

    private static MethodDeclaration method(String source) {
        return StaticJavaParser.parse("class C { " + source + " }")
                .getClassByName("C")
                .orElseThrow()
                .getMethods()
                .getFirst();
    }
}
