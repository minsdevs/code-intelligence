package dev.codeintelligence.common.config;

import dev.codeintelligence.auth.DesktopAuthProperties;
import dev.codeintelligence.auth.DesktopCapabilityFilter;
import jakarta.servlet.DispatcherType;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.config.BeanFactoryPostProcessor;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.core.Ordered;
import org.springframework.core.env.Environment;
import org.springframework.util.StringUtils;

/** Desktop transport settings are a security contract, not overridable insecure defaults. */
@Configuration(proxyBeanMethods = false)
@Profile("desktop")
public class DesktopSecurityConfiguration {

    @Bean
    static BeanFactoryPostProcessor desktopTransportSettings(Environment environment) {
        return factory -> validate(environment);
    }

    @Bean
    FilterRegistrationBean<DesktopCapabilityFilter> desktopCapabilityFilter(DesktopAuthProperties properties) {
        var registration = new FilterRegistrationBean<>(new DesktopCapabilityFilter(properties));
        registration.setOrder(Ordered.HIGHEST_PRECEDENCE);
        registration.setDispatcherTypes(EnumSet.allOf(DispatcherType.class));
        registration.addUrlPatterns("/*");
        registration.setAsyncSupported(true);
        return registration;
    }

    static void validate(Environment env) {
        require("127.0.0.1".equals(value(env, "server.address")), "server.address");
        int port = env.getProperty("server.port", Integer.class, 0);
        require(port > 0 && port <= 65535, "server.port");
        require(Boolean.TRUE.equals(env.getProperty("server.ssl.enabled", Boolean.class)), "server.ssl.enabled");
        require("desktopbackend".equals(value(env, "server.ssl.bundle")), "server.ssl.bundle");
        require("none".equals(value(env, "server.forward-headers-strategy")), "server.forward-headers-strategy");
        List<String> protocols = Binder.get(env)
                .bind("spring.ssl.bundle.pem.desktopbackend.options.enabled-protocols", Bindable.listOf(String.class))
                .orElse(List.of());
        require(
                !protocols.isEmpty() && protocols.stream().allMatch(p -> p.equals("TLSv1.3") || p.equals("TLSv1.2")),
                "spring.ssl.bundle.pem.desktopbackend.options.enabled-protocols");
        for (String key : List.of(
                "spring.ssl.bundle.pem.desktopbackend.keystore.certificate",
                "spring.ssl.bundle.pem.desktopbackend.keystore.private-key",
                "spring.ssl.bundle.pem.desktopredis.truststore.certificate")) {
            requireFileResource(env, key);
        }
        require(
                Boolean.TRUE.equals(env.getProperty("server.servlet.session.cookie.secure", Boolean.class)),
                "server.servlet.session.cookie.secure");
        require(
                Boolean.TRUE.equals(env.getProperty("server.servlet.session.cookie.http-only", Boolean.class)),
                "server.servlet.session.cookie.http-only");
        require(
                "lax".equalsIgnoreCase(value(env, "server.servlet.session.cookie.same-site")),
                "server.servlet.session.cookie.same-site");
        String origin = "https://127.0.0.1:" + port;
        require(origin.equals(value(env, "app.desktop.allowed-origin")), "app.desktop.allowed-origin");
        require(
                Binder.get(env)
                        .bind("app.cors.allowed-origins", Bindable.listOf(String.class))
                        .orElse(List.of())
                        .equals(List.of(origin)),
                "app.cors.allowed-origins");
        String token = value(env, "app.desktop.api-token");
        String pathToken = value(env, "app.desktop.path-token");
        require(token.matches("[a-f0-9]{64}"), "app.desktop.api-token");
        require(pathToken.matches("[a-f0-9]{64}") && !pathToken.equals(token), "app.desktop.path-token");
        require(StringUtils.hasText(value(env, "app.desktop.local-identity")), "app.desktop.local-identity");
        require("127.0.0.1".equals(value(env, "spring.data.redis.host")), "spring.data.redis.host");
        require(
                Boolean.TRUE.equals(env.getProperty("spring.data.redis.ssl.enabled", Boolean.class)),
                "spring.data.redis.ssl.enabled");
        require("desktopredis".equals(value(env, "spring.data.redis.ssl.bundle")), "spring.data.redis.ssl.bundle");
        require(StringUtils.hasText(value(env, "spring.data.redis.password")), "spring.data.redis.password");
        require(StringUtils.hasText(value(env, "spring.datasource.username")), "spring.datasource.username");
        require(StringUtils.hasText(value(env, "spring.datasource.password")), "spring.datasource.password");
        // Alternate connection sources can silently supersede the verified URLs/bundles.
        for (String key : List.of(
                "spring.data.redis.url",
                "spring.data.redis.sentinel.master",
                "spring.data.redis.cluster.nodes",
                "spring.datasource.jndi-name",
                "spring.datasource.hikari.jdbc-url",
                "spring.datasource.hikari.data-source-class-name",
                "spring.flyway.url",
                "spring.flyway.user",
                "spring.flyway.password",
                "management.server.port",
                "server.servlet.session.cookie.domain")) {
            require(!StringUtils.hasText(value(env, key)), key);
        }
        require(
                Binder.get(env)
                        .bind(
                                "spring.datasource.hikari.data-source-properties",
                                Bindable.mapOf(String.class, String.class))
                        .orElse(Map.of())
                        .isEmpty(),
                "spring.datasource.hikari.data-source-properties");
        validateJdbc(value(env, "spring.datasource.url"));
        if (StringUtils.hasText(value(env, "app.github.native-oauth.client-id"))) {
            require(
                    "https://github.com/login/device/code"
                            .equals(value(env, "app.github.native-oauth.device-code-uri")),
                    "app.github.native-oauth.device-code-uri");
            require(
                    "https://github.com/login/oauth/access_token"
                            .equals(value(env, "app.github.native-oauth.token-uri")),
                    "app.github.native-oauth.token-uri");
        }
    }

    private static void validateJdbc(String url) {
        String key = "spring.datasource.url";
        require(url.startsWith("jdbc:postgresql://"), key);
        URI uri = uri(url.substring(5), key);
        require(
                "127.0.0.1".equals(uri.getHost())
                        && uri.getPort() > 0
                        && uri.getPort() <= 65535
                        && uri.getRawUserInfo() == null
                        && uri.getRawFragment() == null
                        && uri.getRawQuery() != null,
                key);
        Map<String, String> query = new HashMap<>();
        try {
            for (String parameter : uri.getRawQuery().split("&", -1)) {
                String[] pair = parameter.split("=", 2);
                require(pair.length == 2, key);
                String name = URLDecoder.decode(pair[0], StandardCharsets.UTF_8);
                require(List.of("sslmode", "sslrootcert").contains(name), key);
                require(query.putIfAbsent(name, URLDecoder.decode(pair[1], StandardCharsets.UTF_8)) == null, key);
            }
            require("verify-full".equals(query.get("sslmode")), key);
            require(
                    query.containsKey("sslrootcert")
                            && Path.of(query.get("sslrootcert")).isAbsolute(),
                    key);
        } catch (IllegalArgumentException invalid) {
            throw new IllegalStateException("Desktop requires secure " + key);
        }
    }

    private static void requireFileResource(Environment env, String key) {
        URI file = uri(value(env, key), key);
        require(
                "file".equals(file.getScheme())
                        && file.getRawQuery() == null
                        && file.getRawFragment() == null
                        && (file.getAuthority() == null || file.getAuthority().isEmpty())
                        && Path.of(file).isAbsolute(),
                key);
    }

    private static URI uri(String value, String key) {
        try {
            return URI.create(value);
        } catch (IllegalArgumentException invalid) {
            throw new IllegalStateException("Desktop requires secure " + key);
        }
    }

    private static String value(Environment env, String key) {
        return env.getProperty(key, "");
    }

    private static void require(boolean condition, String key) {
        if (!condition) throw new IllegalStateException("Desktop requires secure " + key);
    }
}
