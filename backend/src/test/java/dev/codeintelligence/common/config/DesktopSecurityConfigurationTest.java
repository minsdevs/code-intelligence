package dev.codeintelligence.common.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.codeintelligence.auth.DesktopAuthProperties;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.core.Ordered;
import org.springframework.mock.env.MockEnvironment;

class DesktopSecurityConfigurationTest {

    static MockEnvironment secureEnvironment() {
        MockEnvironment env = new MockEnvironment();
        Map.ofEntries(
                        Map.entry("server.address", "127.0.0.1"),
                        Map.entry("server.port", "4311"),
                        Map.entry("server.ssl.enabled", "true"),
                        Map.entry("server.ssl.bundle", "desktopbackend"),
                        Map.entry("server.forward-headers-strategy", "none"),
                        Map.entry("spring.ssl.bundle.pem.desktopbackend.options.enabled-protocols", "TLSv1.3,TLSv1.2"),
                        Map.entry(
                                "spring.ssl.bundle.pem.desktopbackend.keystore.certificate",
                                "file:/private/backend.pem"),
                        Map.entry(
                                "spring.ssl.bundle.pem.desktopbackend.keystore.private-key",
                                "file:/private/backend.key"),
                        Map.entry(
                                "spring.ssl.bundle.pem.desktopredis.truststore.certificate", "file:/private/redis.pem"),
                        Map.entry("server.servlet.session.cookie.secure", "true"),
                        Map.entry("server.servlet.session.cookie.http-only", "true"),
                        Map.entry("server.servlet.session.cookie.same-site", "lax"),
                        Map.entry("app.desktop.allowed-origin", "https://127.0.0.1:4311"),
                        Map.entry("app.cors.allowed-origins", "https://127.0.0.1:4311"),
                        Map.entry("app.desktop.api-token", "a".repeat(64)),
                        Map.entry("app.desktop.path-token", "b".repeat(64)),
                        Map.entry("app.desktop.local-identity", "test-installation"),
                        Map.entry("spring.data.redis.host", "127.0.0.1"),
                        Map.entry("spring.data.redis.ssl.enabled", "true"),
                        Map.entry("spring.data.redis.ssl.bundle", "desktopredis"),
                        Map.entry("spring.data.redis.password", "isolated-test-redis"),
                        Map.entry("spring.datasource.username", "isolated-test-user"),
                        Map.entry("spring.datasource.password", "isolated-test-password"),
                        Map.entry(
                                "spring.datasource.url",
                                "jdbc:postgresql://127.0.0.1:54321/test?sslmode=verify-full&sslrootcert=%2Fprivate%2Fpostgres.pem"),
                        Map.entry("app.github.native-oauth.client-id", "public-client"),
                        Map.entry(
                                "app.github.native-oauth.redirect-uri",
                                "http://127.0.0.1:4312/api/auth/github/native/callback"))
                .forEach(env::setProperty);
        env.setActiveProfiles("desktop");
        return env;
    }

    @Test
    void acceptsSecureContractAndRegistersBeforeSessionAndSecurity() {
        assertThatCode(() -> DesktopSecurityConfiguration.validate(secureEnvironment()))
                .doesNotThrowAnyException();
        var registration = new DesktopSecurityConfiguration()
                .desktopCapabilityFilter(new DesktopAuthProperties("a".repeat(64), "test", "https://127.0.0.1:4311"));
        assertThat(registration.getOrder()).isEqualTo(Ordered.HIGHEST_PRECEDENCE);
        assertThat(registration.getUrlPatterns()).containsExactly("/*");
    }

    @Test
    void rejectsMissingOrWeakenedTransportSettings() {
        Map.ofEntries(
                        Map.entry("server.ssl.enabled", "false"),
                        Map.entry("server.ssl.bundle", "other"),
                        Map.entry("server.address", "0.0.0.0"),
                        Map.entry("server.port", "0"),
                        Map.entry("server.forward-headers-strategy", "framework"),
                        Map.entry("spring.ssl.bundle.pem.desktopbackend.options.enabled-protocols", "TLSv1.1,TLSv1.2"),
                        Map.entry("spring.ssl.bundle.pem.desktopbackend.keystore.private-key", "classpath:shared.key"),
                        Map.entry("spring.ssl.bundle.pem.desktopredis.truststore.certificate", ""),
                        Map.entry("server.servlet.session.cookie.secure", "false"),
                        Map.entry("server.servlet.session.cookie.http-only", "false"),
                        Map.entry("server.servlet.session.cookie.same-site", "none"),
                        Map.entry("app.desktop.allowed-origin", "http://127.0.0.1:4311"),
                        Map.entry("app.cors.allowed-origins", "https://127.0.0.1:4311,http://evil.test"),
                        Map.entry("app.desktop.api-token", ""),
                        Map.entry("app.desktop.path-token", "a".repeat(64)),
                        Map.entry("app.desktop.local-identity", ""),
                        Map.entry("spring.data.redis.host", "localhost"),
                        Map.entry("spring.data.redis.ssl.enabled", "false"),
                        Map.entry("spring.data.redis.ssl.bundle", "other"),
                        Map.entry("spring.data.redis.password", ""),
                        Map.entry("spring.data.redis.url", "redis://127.0.0.1:6379"),
                        Map.entry("spring.data.redis.cluster.nodes", "127.0.0.1:6379"),
                        Map.entry("spring.datasource.hikari.data-source-properties.sslmode", "disable"),
                        Map.entry("spring.flyway.url", "jdbc:postgresql://127.0.0.1/test"),
                        Map.entry("management.server.port", "8001"))
                .forEach((key, value) -> assertThatThrownBy(() -> DesktopSecurityConfiguration.validate(
                                secureEnvironment().withProperty(key, value)))
                        .as(key)
                        .isInstanceOf(IllegalStateException.class));
    }

    @Test
    void rejectsJdbcAuthenticationBypasses() {
        for (String query : new String[] {
            "sslmode=require&sslrootcert=/private/ca.pem",
            "sslmode=verify-full&sslrootcert=relative.pem",
            "sslmode=verify-full",
            "sslmode=verify-full&sslrootcert=/private/ca.pem&sslmode=disable",
            "sslmode=verify-full&sslrootcert=/private/ca.pem&sslfactory=org.postgresql.ssl.NonValidatingFactory",
            "sslmode=verify-full&sslrootcert=/private/ca.pem&sslhostnameverifier=example.AcceptAll"
        }) {
            assertThatThrownBy(() -> DesktopSecurityConfiguration.validate(secureEnvironment()
                            .withProperty("spring.datasource.url", "jdbc:postgresql://127.0.0.1:54321/test?" + query)))
                    .isInstanceOf(IllegalStateException.class);
        }
    }

    @Test
    void requiresOriginalNarrowHttpCallbackOnSeparateLoopbackPort() {
        for (String uri : new String[] {
            "https://127.0.0.1:4311/api/auth/github/native/callback",
            "http://127.0.0.1:4311/api/auth/github/native/callback",
            "http://localhost:4312/api/auth/github/native/callback",
            "http://127.0.0.1:4312/other",
            "http://127.0.0.1:4312/api/auth/github/native/callback?extra=1"
        }) {
            assertThatThrownBy(() -> DesktopSecurityConfiguration.validate(
                            secureEnvironment().withProperty("app.github.native-oauth.redirect-uri", uri)))
                    .isInstanceOf(IllegalStateException.class);
        }
    }

    @Test
    void desktopStartupFailsBeforeAnyRegularBeanConstructionButWebModeIsUnchanged() {
        try (var context = new AnnotationConfigApplicationContext()) {
            context.setEnvironment(secureEnvironment().withProperty("server.ssl.enabled", "false"));
            context.register(DesktopSecurityConfiguration.class);
            assertThatThrownBy(context::refresh)
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("server.ssl.enabled");
        }
        try (var context = new AnnotationConfigApplicationContext(DesktopSecurityConfiguration.class)) {
            assertThat(context.getBeansOfType(DesktopSecurityConfiguration.class))
                    .isEmpty();
        }
    }
}
