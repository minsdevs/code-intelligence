package dev.codeintelligence.analysis.cross;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.EdgeConfidence;
import org.junit.jupiter.api.Test;

class EndpointPathMatcherTest {

    @Test
    void exactMatchIsConfirmed() {
        assertThat(EndpointPathMatcher.match("POST", "/auth/login", "POST", "/auth/login"))
                .isEqualTo(EdgeConfidence.CONFIRMED);
        assertThat(EndpointPathMatcher.match("get", "/todos", "GET", "/todos")).isEqualTo(EdgeConfidence.CONFIRMED);
    }

    @Test
    void templateNormalizationIsLikely() {
        assertThat(EndpointPathMatcher.match("GET", "/users/${id}", "GET", "/users/{id}"))
                .isEqualTo(EdgeConfidence.LIKELY);
        assertThat(EndpointPathMatcher.match("GET", "/users/:id", "GET", "/users/{id}"))
                .isEqualTo(EdgeConfidence.LIKELY);
    }

    @Test
    void suffixOnlyIsPossible() {
        assertThat(EndpointPathMatcher.match("GET", "/api/todos", "GET", "/todos"))
                .isEqualTo(EdgeConfidence.POSSIBLE);
    }

    @Test
    void methodMismatchDoesNotMatch() {
        assertThat(EndpointPathMatcher.match("POST", "/todos", "GET", "/todos")).isNull();
    }

    @Test
    void anyMethodEndpointMatchesEveryCallMethod() {
        assertThat(EndpointPathMatcher.match("POST", "/api/items/", "ANY", "/api/items/"))
                .isEqualTo(EdgeConfidence.CONFIRMED);
        assertThat(EndpointPathMatcher.match("GET", "/api/items/", "ANY", "/api/items/"))
                .isEqualTo(EdgeConfidence.CONFIRMED);
        assertThat(EndpointPathMatcher.match("DELETE", "/api/items/", "ANY", "/api/items/"))
                .isEqualTo(EdgeConfidence.CONFIRMED);
        assertThat(EndpointPathMatcher.match("GET", "/api/items", "ANY", "/api/items/"))
                .isEqualTo(EdgeConfidence.CONFIRMED);
    }
}
