package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;

/**
 * PK-08 at full-stack level: main composes its provider transport from validation-build metadata (the
 * production default path, no injected transport) and sends over real loopback HTTP to a fake provider.
 * The packaged run of the same flow is {@code validation/pre-release/cost-egress-packaged-ask.cjs}.
 */
@TestPropertySource(properties = "ci.c13.validation-provider=true")
class AiCostEgressValidationProviderIntegrationTest extends CostEgressHarness {
    static final List<String> PERSONAL =
            List.of("jane.sentinel@example.invalid", "010-2345-6789", "4111 1111 1111 1111");

    @Test
    @DisplayName("PK-08 validation transport: one approved, masked request over loopback HTTP, settled exactly")
    void validationProviderVariantSendsTheApprovedMaskedRequestOnceAndSettles() throws Exception {
        readyForRequests("10000000", "10000000");
        Fixture fixture = sourceFixture(Map.of(
                SOURCE,
                "// owner %s, phone %s, card %s\nclass App { String value = \"approved-desktop-source\"; }\n"
                        .formatted(PERSONAL.toArray())));
        Money before = money();
        Map<String, Object> plan = prepare(fixture);
        assertThat(runtime.httpProviderRequests()).isEmpty();

        Map<String, Object> answer = success(ask(fixture, plan));
        assertThat(answer).containsEntry("explanation", "Synthetic desktop answer");
        // The injected call-counting transport is not used in this mode; the wire is real HTTP.
        assertThat(runtime.events()).isEmpty();
        List<Map<String, Object>> received = runtime.httpProviderRequests();
        assertThat(received).hasSize(1);
        Map<String, Object> sent = received.getFirst();
        assertThat(sent)
                .containsEntry("method", "POST")
                .containsEntry("path", "/v1/chat/completions")
                .containsEntry("contentType", "application/json")
                .containsEntry("credentialMatched", true);
        assertThat((String) sent.get("remoteAddress")).matches("(::ffff:)?127\\.0\\.0\\.1");
        byte[] wire = Base64.getDecoder().decode((String) sent.get("bodyBase64"));
        String body = new String(wire, StandardCharsets.UTF_8);
        assertThat(PERSONAL.stream().filter(body::contains).toList()).isEmpty();
        Map<?, ?> json = this.json.readValue(wire, Map.class);
        assertThat(((Map<?, ?>) ((List<?>) json.get("messages")).get(1)).get("content"))
                .isEqualTo(plan.get("userPrompt"));
        assertThat((String) plan.get("userPrompt")).contains("[EMAIL_1]", "[PHONE_1]", "[CARD_1]");
        assertThat(requestRow(plan)).containsEntry("wire_body_sha256", sha(wire));
        assertObligation((String) plan.get("requestId"), "SETTLED", RESERVATION, ACTUAL);
        Money after = money();
        assertThat(after.held()).isEqualTo(before.held());
        assertThat(after.dailySettled()).isEqualTo(before.dailySettled() + ACTUAL);
        assertLedgerAgreement();

        // Replay of the consumed approval: refused before any provider call.
        error(ask(fixture, plan), 409, "AI_REQUEST_PLAN_REQUIRED");
        assertThat(runtime.httpProviderRequests()).hasSize(1);
        // Stray local probes of the port, if any, are not provider calls and never carried a credential.
        System.out.println("PK-08 full-stack stray requests: " + runtime.httpStrayRequests());
        assertThat(runtime.httpStrayRequests())
                .allSatisfy(stray -> assertThat(stray).containsEntry("authorizationPresent", false));
    }
}
