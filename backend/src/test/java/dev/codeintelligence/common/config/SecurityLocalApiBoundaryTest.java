package dev.codeintelligence.common.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.setup.SecurityMockMvcConfigurers.springSecurity;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import dev.codeintelligence.auth.DesktopAuthProperties;
import dev.codeintelligence.auth.DesktopAuthenticationFilter;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockServletContext;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.support.AnnotationConfigWebApplicationContext;

/**
 * G-SEC local API boundary (05 §2: loopback bind + installation token + CSRF/CORS/Origin). Each case
 * models a browser page or another local process: DNS rebinding Host names, another loopback port,
 * cross-site fetch metadata, opaque origins, CORS preflight and transport downgrade. The actual
 * desktop capability gate and Spring Security chain are used; no network or database is involved.
 */
class SecurityLocalApiBoundaryTest {
    private static final String TOKEN = "a".repeat(64);
    private static final String ORIGIN = "https://127.0.0.1:4311";
    private static final String HEADER = DesktopAuthenticationFilter.TOKEN_HEADER;
    private AnnotationConfigWebApplicationContext context;
    private MockMvc mvc;

    @BeforeEach
    void startSecurityChain() {
        context = new AnnotationConfigWebApplicationContext();
        context.setEnvironment(DesktopSecurityConfigurationTest.secureEnvironment());
        context.setServletContext(new MockServletContext());
        context.register(DesktopRequestSecurityTest.TestConfiguration.class, DesktopSecurityConfiguration.class);
        context.refresh();
        var gate = context.getBean(DesktopSecurityConfiguration.class)
                .desktopCapabilityFilter(context.getBean(DesktopAuthProperties.class))
                .getFilter();
        mvc = MockMvcBuilders.webAppContextSetup(context)
                .addFilters(gate)
                .apply(springSecurity())
                .build();
    }

    @AfterEach
    void close() {
        context.close();
    }

    private int status(MockHttpServletRequestBuilder request) throws Exception {
        return mvc.perform(request).andReturn().getResponse().getStatus();
    }

    @Test
    void dnsRebindingAndOtherLocalProcessesCannotUseTheApiWithoutTheInstallationToken() throws Exception {
        for (String host : List.of("attacker.example:4311", "127.0.0.1.nip.io:4311", "localhost:4311", "[::1]:4311")) {
            for (var request : List.of(
                    get("/api/projects"),
                    get("/"),
                    get("/actuator/health"),
                    post("/api/projects"),
                    post("/api/desktop/paths"))) {
                assertThat(status(request.secure(true).header("Host", host).header("Origin", "https://" + host)))
                        .as(host)
                        .isEqualTo(401);
            }
        }
        // A different local process on the same loopback address still lacks the per-install token.
        assertThat(status(get("/api/projects").secure(true).header(HEADER, "b".repeat(64))))
                .isEqualTo(401);
        assertThat(status(get("/api/projects").secure(true).header(HEADER, TOKEN.toUpperCase())))
                .isEqualTo(401);
        assertThat(status(get("/api/projects").secure(true).header(HEADER, " " + TOKEN)))
                .isEqualTo(401);
        assertThat(status(get("/api/projects").secure(true).header(HEADER, TOKEN, TOKEN)))
                .isEqualTo(401);
        assertThat(status(
                        get("/api/projects").secure(false).header(HEADER, TOKEN).header("Origin", ORIGIN)))
                .as("plain HTTP is never accepted even with the token")
                .isEqualTo(401);
    }

    @Test
    void aLeakedTokenIsStillRefusedFromForeignOriginsPortsSchemesAndCrossSiteMetadata() throws Exception {
        for (String origin : List.of(
                "https://attacker.example:4311",
                "https://127.0.0.1:4312",
                "https://127.0.0.1",
                "http://127.0.0.1:4311",
                "https://localhost:4311",
                "https://[::1]:4311",
                "https://[::ffff:127.0.0.1]:4311",
                "https://2130706433:4311",
                "https://127.0.0.1:4311/",
                "https://127.0.0.1:4311@attacker.example",
                "https://user@127.0.0.1:4311",
                "null",
                "file://",
                "chrome-extension://abcdefghijklmnop")) {
            assertThat(status(get("/api/projects")
                            .secure(true)
                            .header(HEADER, TOKEN)
                            .header("Origin", origin)))
                    .as(origin)
                    .isEqualTo(403);
        }
        for (String referer :
                List.of("https://attacker.example/", "https://127.0.0.1:4312/", "http://127.0.0.1:4311/")) {
            assertThat(status(get("/api/projects")
                            .secure(true)
                            .header(HEADER, TOKEN)
                            .header("Referer", referer)))
                    .as(referer)
                    .isEqualTo(403);
        }
        for (String site : List.of("cross-site", "same-site")) {
            assertThat(status(get("/api/projects")
                            .secure(true)
                            .header(HEADER, TOKEN)
                            .header("Sec-Fetch-Site", site)))
                    .as(site)
                    .isEqualTo(403);
        }
        assertThat(status(get("/api/projects")
                        .secure(true)
                        .header(HEADER, TOKEN)
                        .header("Sec-Fetch-Site", "none")
                        .header("Sec-Fetch-Mode", "cors")
                        .header("Sec-Fetch-Dest", "empty")))
                .as("user-initiated metadata is only accepted for a top-level document GET")
                .isEqualTo(403);
        assertThat(status(
                        get("/api/projects").secure(true).header(HEADER, TOKEN).header("Origin", ORIGIN)))
                .isEqualTo(200);
    }

    @Test
    void crossOriginPreflightAndMutationsGetNoCorsGrantOrStateChange() throws Exception {
        MvcResult preflight = mvc.perform(options("/api/projects")
                        .secure(true)
                        .header("Origin", "https://attacker.example")
                        .header("Access-Control-Request-Method", "POST")
                        .header("Access-Control-Request-Headers", HEADER))
                .andReturn();
        assertThat(preflight.getResponse().getStatus()).isEqualTo(401);
        assertThat(preflight.getResponse().getHeader("Access-Control-Allow-Origin"))
                .isNull();

        MvcResult mutation = mvc.perform(
                        post("/api/projects").secure(true).header(HEADER, TOKEN).header("Origin", ORIGIN))
                .andReturn();
        assertThat(mutation.getResponse().getStatus())
                .as("same-origin mutation without the CSRF double-submit cookie")
                .isEqualTo(403);
        assertThat(context.getBean(DesktopRequestSecurityTest.TestEndpoints.class))
                .extracting("mutations")
                .asString()
                .isEqualTo("0");
    }

    @Test
    void pathGrantNeedsTheMainOnlyPathCapabilityEvenFromTheTrustedOrigin() throws Exception {
        assertThat(status(post("/api/desktop/paths")
                        .secure(true)
                        .header(HEADER, TOKEN)
                        .header("Origin", ORIGIN)
                        .contentType("application/json")
                        .content("{\"path\":\"/\"}")))
                .isIn(401, 403);
        assertThat(status(post("/api/desktop/paths")
                        .secure(true)
                        .header(HEADER, TOKEN)
                        .header("Origin", ORIGIN)
                        .header("X-Code-Intelligence-Path-Token", TOKEN)
                        .contentType("application/json")
                        .content("{\"path\":\"/\"}")))
                .as("the API token is not the path capability")
                .isIn(401, 403);
    }
}
