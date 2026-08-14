package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class LlmJsonTest {

    private final JsonMapper json = JsonMapper.builder().build();

    @Test
    void parsesClaimsAndAlternatives() {
        AIProvider.ChatResponse response = LlmJson.parse(json, """
                {"explanation":"ok","claims":[{"text":"used","confidence":"LIKELY","evidence":["file:A.java:2"]}],
                 "alternatives":[{"name":"B","pros":["p"],"cons":["c"],"fitForThisProject":"yes"}]}
                """, 1, 2);
        assertThat(response.explanation()).isEqualTo("ok");
        assertThat(response.claims())
                .containsExactly(new AIProvider.Claim("used", "LIKELY", java.util.List.of("file:A.java:2")));
        assertThat(response.alternatives()).hasSize(1);
        assertThat(response.promptTokens()).isEqualTo(1);
    }

    @Test
    void fallsBackWhenNotJson() {
        AIProvider.ChatResponse response = LlmJson.parse(json, "not-json", 0, 0);
        assertThat(response.claims()).isEmpty();
        assertThat(response.explanation()).isEqualTo("not-json");
    }
}
