package dev.codeintelligence;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.project.ProjectRepository;
import java.io.IOException;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.availability.AvailabilityChangeEvent;
import org.springframework.boot.availability.ReadinessState;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Import;
import org.springframework.core.env.PropertySource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.orm.jpa.LocalContainerEntityManagerFactoryBean;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;

/**
 * Applies the desktop profile's startup settings, read from {@code application-desktop.yml}, to the
 * full application with real PostgreSQL and Redis. The desktop profile itself also needs per-launch
 * TLS and capability configuration, which is covered by the native acceptance runs.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
@AutoConfigureRestTestClient
@Import(TestcontainersConfiguration.class)
class DesktopStartupSettingsIntegrationTest {

    private static final List<String> DESKTOP_STARTUP_KEYS = List.of(
            "spring.data.jpa.repositories.bootstrap-mode",
            "spring.data.redis.repositories.enabled",
            "spring.datasource.hikari.minimum-idle",
            "springdoc.api-docs.enabled",
            "springdoc.swagger-ui.enabled",
            "management.health.readinessstate.enabled");

    @DynamicPropertySource
    static void desktopStartupSettings(DynamicPropertyRegistry registry) throws IOException {
        PropertySource<?> desktop = new YamlPropertySourceLoader()
                .load("desktop", new ClassPathResource("application-desktop.yml"))
                .getFirst();
        for (String key : DESKTOP_STARTUP_KEYS) {
            Object value = desktop.getProperty(key);
            assertThat(value).as(key).isNotNull();
            registry.add(key, () -> value);
        }
    }

    @Autowired
    private RestTestClient restTestClient;

    @Autowired
    private ConfigurableApplicationContext context;

    @Autowired
    private ProjectRepository projects;

    @Test
    void entityManagerFactoryIsBuiltOnTheBootstrapExecutorAndRepositoriesWork() {
        LocalContainerEntityManagerFactoryBean factory =
                context.getBean("&entityManagerFactory", LocalContainerEntityManagerFactoryBean.class);
        assertThat(factory.getBootstrapExecutor()).isNotNull();
        assertThat(projects.count()).isGreaterThanOrEqualTo(0);
    }

    @Test
    void rootHealthIsOutOfServiceWhileReadinessRefusesTraffic() {
        restTestClient.get().uri("/actuator/health").exchange().expectStatus().isOk();
        AvailabilityChangeEvent.publish(context, ReadinessState.REFUSING_TRAFFIC);
        try {
            restTestClient
                    .get()
                    .uri("/actuator/health")
                    .exchange()
                    .expectStatus()
                    .isEqualTo(503)
                    .expectBody(String.class)
                    .value(body -> assertThat(body).contains("\"status\":\"OUT_OF_SERVICE\""));
        } finally {
            AvailabilityChangeEvent.publish(context, ReadinessState.ACCEPTING_TRAFFIC);
        }
        restTestClient.get().uri("/actuator/health").exchange().expectStatus().isOk();
    }

    @Test
    void apiDocumentationIsNotServed() {
        restTestClient.get().uri("/v3/api-docs").exchange().expectStatus().isNotFound();
    }
}
