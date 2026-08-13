package dev.codeintelligence;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.web.servlet.client.RestTestClient;

/**
 * Proves the conditional OAuth wiring: with client credentials present the context still boots,
 * oauth2Login is registered, and /api/auth/me advertises OAuth availability to the frontend.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            "app.github.oauth.client-id=test-client-id",
            "app.github.oauth.client-secret=test-client-secret"
        })
@AutoConfigureRestTestClient
@Import(TestcontainersConfiguration.class)
class OAuthEnabledIntegrationTest {

    @Autowired
    private RestTestClient restTestClient;

    @Test
    void meAdvertisesOauthAvailability() {
        restTestClient
                .get()
                .uri("/api/auth/me")
                .exchange()
                .expectStatus()
                .isOk()
                .expectBody()
                .jsonPath("$.authenticated")
                .isEqualTo(false)
                .jsonPath("$.oauthAvailable")
                .isEqualTo(true);
    }
}
