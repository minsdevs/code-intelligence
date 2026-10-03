package dev.codeintelligence.analysis.ts;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/** Pure contract tests for a future Java gate; no server, subprocess or database. */
class TsSyntaxInputExceptionTest {
    private static final JsonMapper JSON = JsonMapper.builder().build();

    @Test
    void mapsTheSharedSidecarFixtureToTheSafeJobApiMessage() throws Exception {
        try (var stream = getClass().getResourceAsStream("/fixtures/ts-syntax-error.json")) {
            var fixture = JSON.readTree(stream);
            var error = TsSyntaxInputException.fromResponse(JSON.writeValueAsBytes(fixture.get("response")));
            assertThat(error).isNotNull();
            assertThat(error.failureCode()).isEqualTo("TS_SYNTAX_ERROR");
            assertThat(error.getMessage()).isEqualTo(fixture.get("jobError").stringValue());
            assertThat(error.getCause()).isNull();
        }
    }

    @Test
    void rejectsMalformedUnknownOversizedAndDuplicateKeyBodiesWithoutForwardingTheirText() {
        for (String body : List.of("", "{", "{}", "[]", "\"source-content\"", "x".repeat(65_537),
                "{\"code\":\"TS_SYNTAX_ERROR\",\"code\":\"OTHER\"}")) {
            assertThat(TsSyntaxInputException.fromResponse(body.getBytes(StandardCharsets.UTF_8))).isNull();
        }
        var body = validBody();
        body.put("totalDiagnostics", 0);
        assertThat(TsSyntaxInputException.fromResponse(JSON.writeValueAsBytes(body))).isNull();
        body.put("totalDiagnostics", 1);
        body.put("retryable", true);
        assertThat(TsSyntaxInputException.fromResponse(JSON.writeValueAsBytes(body))).isNull();
    }

    @Test
    void keepsTheFailureCodeButOmitsUnsafePathsAndAllUntrustedMessageText() {
        for (String path : List.of("/private/secret.ts", "../secret.ts", "C:\\private\\secret.ts", "line\nsecret.ts",
                "src/\u202esecret.ts", "x".repeat(241))) {
            var body = validBody();
            body.put("message", "SYNTHETIC_SECRET_MARKER");
            ((tools.jackson.databind.node.ObjectNode) body.get("diagnostics").get(0)).put("filePath", path);
            var error = TsSyntaxInputException.fromResponse(JSON.writeValueAsBytes(body));
            assertThat(error).isNotNull();
            assertThat(error.getMessage()).contains("Location unavailable").doesNotContain("SYNTHETIC_SECRET_MARKER", path);
            assertThat(error.getMessage()).hasSizeLessThan(500);
        }
    }

    private static tools.jackson.databind.node.ObjectNode validBody() {
        return (tools.jackson.databind.node.ObjectNode) JSON.readTree("""
                {"code":"TS_SYNTAX_ERROR","retryable":false,"totalDiagnostics":1,
                 "diagnostics":[{"filePath":"src/broken.mts","code":1109,"lineStart":1,"columnStart":22}]}
                """);
    }
}
