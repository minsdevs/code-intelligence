package dev.codeintelligence.common.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.setup.SecurityMockMvcConfigurers.springSecurity;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import dev.codeintelligence.auth.AccountService;
import dev.codeintelligence.auth.AuthProperties;
import dev.codeintelligence.auth.DesktopAuthProperties;
import dev.codeintelligence.auth.DesktopAuthenticationFilter;
import dev.codeintelligence.auth.DesktopCapabilityFilter;
import dev.codeintelligence.auth.GithubOAuth2UserService;
import dev.codeintelligence.auth.UserAccount;
import dev.codeintelligence.job.AnalysisMemoryWatchdog;
import dev.codeintelligence.job.OwnerTreeMemoryController;
import dev.codeintelligence.job.ReportedOwnerTreeMemory;
import dev.codeintelligence.project.DesktopPathAuthorizationController;
import dev.codeintelligence.project.DesktopPathAuthorizationService;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.http.Cookie;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.mock.web.MockServletContext;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.access.AccessDeniedHandlerImpl;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.csrf.MissingCsrfTokenException;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.support.AnnotationConfigWebApplicationContext;
import org.springframework.web.servlet.config.annotation.EnableWebMvc;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

class DesktopRequestSecurityTest {
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
        context.register(TestConfiguration.class, DesktopSecurityConfiguration.class);
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
        SecurityContextHolder.clearContext();
    }

    @Test
    void requiresCurrentCapabilityForStaticHealthCsrfAuthenticationAndExistingSession() throws Exception {
        MockHttpSession previousSession = new MockHttpSession();
        var oldContext = SecurityContextHolder.createEmptyContext();
        oldContext.setAuthentication(UsernamePasswordAuthenticationToken.authenticated(
                "previous-launch-user", null, AuthorityUtils.createAuthorityList("ROLE_USER")));
        previousSession.setAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY, oldContext);
        for (String path : List.of(
                "/",
                "/index.html",
                "/assets/audit-bootstrap.js",
                "/actuator/health",
                "/api/csrf",
                "/api/auth/me",
                "/api/projects",
                "/api/auth/github/connection")) {
            mvc.perform(get(path).secure(true).session(previousSession)).andExpect(status().isUnauthorized());
            mvc.perform(get(path).secure(true).session(previousSession).header(HEADER, "previous-launch-token"))
                    .andExpect(status().isUnauthorized());
            mvc.perform(get(path).secure(true).header(HEADER, "b".repeat(64))).andExpect(status().isUnauthorized());
        }
        // Capability denial precedes even CSRF denial, and never creates a CSRF cookie or session.
        var denied = mvc.perform(post("/api/auth/github/native/poll/00000000-0000-0000-0000-000000000001")
                        .secure(true)
                        .session(previousSession))
                .andExpect(status().isUnauthorized())
                .andReturn();
        assertThat(denied.getResponse().getCookies()).isEmpty();
        assertThat(previousSession.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY))
                .isSameAs(oldContext);
    }

    @Test
    void firstDocumentAndApiWorkButMutationsStillRequireRealCsrfCookie() throws Exception {
        var first = mvc.perform(get("/").secure(true)
                        .header(HEADER, TOKEN)
                        .header("Sec-Fetch-Site", "none")
                        .header("Sec-Fetch-Mode", "navigate")
                        .header("Sec-Fetch-Dest", "document"))
                .andExpect(status().isOk())
                .andReturn();
        Cookie csrf = first.getResponse().getCookie("XSRF-TOKEN");
        assertThat(csrf).isNotNull();
        assertThat(csrf.getSecure()).isTrue();
        assertThat(csrf.isHttpOnly()).isFalse();
        assertThat(csrf.getAttribute("SameSite")).isEqualTo("Lax");
        mvc.perform(get("/api/projects").secure(true).header(HEADER, TOKEN)).andExpect(status().isOk());
        mvc.perform(get("/assets/audit-bootstrap.js").secure(true).header(HEADER, TOKEN))
                .andExpect(status().isOk());
        TestEndpoints endpoints = context.getBean(TestEndpoints.class);
        assertThat(endpoints.mutations.get()).isZero();
        mvc.perform(post("/api/projects").secure(true).header(HEADER, TOKEN))
                .andExpect(status().isForbidden())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.type").value("about:blank"))
                .andExpect(jsonPath("$.status").value(403))
                .andExpect(jsonPath("$.code").value("CSRF_INVALID"))
                .andExpect(jsonPath("$.detail").value("CSRF token is missing or invalid."));
        var mismatch = mvc.perform(post("/api/projects")
                        .secure(true)
                        .header(HEADER, TOKEN)
                        .cookie(csrf)
                        .header("X-XSRF-TOKEN", "synthetic-mismatched-csrf")
                        .header("Origin", ORIGIN))
                .andExpect(status().isForbidden())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Forbidden"))
                .andExpect(jsonPath("$.status").value(403))
                .andExpect(jsonPath("$.code").value("CSRF_INVALID"))
                .andExpect(jsonPath("$.detail").value("CSRF token is missing or invalid."))
                .andReturn();
        assertThat(mismatch.getResponse().getContentAsString())
                .doesNotContain("synthetic-mismatched-csrf", csrf.getValue(), TOKEN);
        assertThat(endpoints.mutations.get()).isZero();
        mvc.perform(post("/api/projects")
                        .secure(true)
                        .header(HEADER, TOKEN)
                        .cookie(csrf)
                        .header("X-XSRF-TOKEN", csrf.getValue())
                        .header("Origin", ORIGIN))
                .andExpect(status().isOk());
        assertThat(endpoints.mutations.get()).isEqualTo(1);
        var crossOrigin = mvc.perform(post("/api/projects")
                        .secure(true)
                        .header(HEADER, TOKEN)
                        .cookie(csrf)
                        .header("X-XSRF-TOKEN", csrf.getValue())
                        .header("Origin", "https://evil.test"))
                .andExpect(status().isForbidden())
                .andReturn();
        assertThat(crossOrigin.getResponse().getContentAsString()).doesNotContain("CSRF_INVALID");
        assertThat(endpoints.mutations.get()).isEqualTo(1);
        mvc.perform(get("/").secure(true).header(HEADER, TOKEN, TOKEN)).andExpect(status().isUnauthorized());
        mvc.perform(get("/").header(HEADER, TOKEN)).andExpect(status().isUnauthorized());
    }

    @Test
    void nonCsrfAccessDenialsKeepTheDefaultResponseEvenWhenTheirMessageOrCauseMentionsCsrf() throws Exception {
        var handler = new SecurityConfig.CsrfProblemAccessDeniedHandler();
        for (AccessDeniedException exception : List.of(
                new AccessDeniedException("CSRF_INVALID: upstream permission or SSO denied"),
                new AccessDeniedException(
                        "Wrapped denial", new MissingCsrfTokenException("synthetic-private-token")))) {
            MockHttpServletRequest request = new MockHttpServletRequest();
            MockHttpServletResponse expected = new MockHttpServletResponse();
            MockHttpServletResponse actual = new MockHttpServletResponse();
            new AccessDeniedHandlerImpl().handle(request, expected, exception);
            handler.handle(request, actual, exception);

            assertThat(actual.getStatus()).isEqualTo(403).isEqualTo(expected.getStatus());
            assertThat(actual.getErrorMessage()).isEqualTo(expected.getErrorMessage());
            assertThat(actual.getContentType()).isEqualTo(expected.getContentType());
            assertThat(actual.getContentAsString())
                    .isEqualTo(expected.getContentAsString())
                    .doesNotContain("CSRF_INVALID", "synthetic-private-token");
        }
    }

    @Test
    void gateNeverConsultsSessionAndGuardsEveryDispatcherType() throws Exception {
        var gate = new DesktopCapabilityFilter(new DesktopAuthProperties(TOKEN, "test", ORIGIN));
        for (DispatcherType type : DispatcherType.values()) {
            MockHttpServletRequest request = new MockHttpServletRequest() {
                @Override
                public jakarta.servlet.http.HttpSession getSession(boolean create) {
                    throw new AssertionError("Capability gate must run before session access");
                }
            };
            request.setSecure(true);
            request.setDispatcherType(type);
            MockHttpServletResponse response = new MockHttpServletResponse();
            AtomicBoolean continued = new AtomicBoolean();
            gate.doFilter(request, response, (req, res) -> continued.set(true));
            assertThat(response.getStatus()).isEqualTo(401);
            assertThat(continued).isFalse();
        }
    }

    @Test
    void pathGrantRequiresSeparateMainCapabilityEvenWithValidApiToken(@TempDir Path folder) throws Exception {
        String body = "{\"path\":\"" + folder.toString().replace("\\", "\\\\") + "\"}";
        mvc.perform(post("/api/desktop/paths")
                        .secure(true)
                        .header(HEADER, TOKEN)
                        .contentType("application/json")
                        .content(body))
                .andExpect(status().isForbidden());
        mvc.perform(post("/api/desktop/paths")
                        .secure(true)
                        .header(HEADER, TOKEN)
                        .header("X-Code-Intelligence-Path-Token", TOKEN)
                        .contentType("application/json")
                        .content(body))
                .andExpect(status().isForbidden());
        mvc.perform(post("/api/desktop/paths")
                        .secure(true)
                        .header(HEADER, TOKEN)
                        .header("X-Code-Intelligence-Path-Token", "b".repeat(64))
                        .contentType("application/json")
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.path").value(folder.toRealPath().toString()))
                .andExpect(jsonPath("$.grant").value(org.hamcrest.Matchers.matchesPattern("[0-9a-f]{64}")))
                .andExpect(jsonPath("$.expiresAt").isString());
        assertThat(context.getBean(DesktopPathAuthorizationService.class).isAuthorized(folder.toRealPath()))
                .isTrue();
    }

    @Test
    void ownerMemoryIsReportedOnlyByMainAndAnswersWhetherARunIsWatched() throws Exception {
        String body = "{\"ownerTreeBytes\":1073741824}";
        var memory = context.getBean(ReportedOwnerTreeMemory.class);
        mvc.perform(post(OwnerTreeMemoryController.PATH)
                        .secure(true)
                        .header(HEADER, TOKEN)
                        .contentType("application/json")
                        .content(body))
                .andExpect(status().isForbidden());
        mvc.perform(post(OwnerTreeMemoryController.PATH)
                        .secure(true)
                        .header(HEADER, TOKEN)
                        .header("X-Code-Intelligence-Path-Token", TOKEN)
                        .contentType("application/json")
                        .content(body))
                .andExpect(status().isForbidden());
        assertThat(memory.ownerTreeBytes()).isEmpty();
        mvc.perform(post(OwnerTreeMemoryController.PATH)
                        .secure(true)
                        .header(HEADER, TOKEN)
                        .header("X-Code-Intelligence-Path-Token", "b".repeat(64))
                        .contentType("application/json")
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.watching").value(false));
        assertThat(memory.ownerTreeBytes()).hasValue(1073741824L);
        try (var ignored = context.getBean(AnalysisMemoryWatchdog.class).watch(() -> {})) {
            mvc.perform(post(OwnerTreeMemoryController.PATH)
                            .secure(true)
                            .header(HEADER, TOKEN)
                            .header("X-Code-Intelligence-Path-Token", "b".repeat(64))
                            .contentType("application/json")
                            .content(body))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.watching").value(true));
        }
        mvc.perform(post(OwnerTreeMemoryController.PATH)
                        .secure(true)
                        .header(HEADER, TOKEN)
                        .header("X-Code-Intelligence-Path-Token", "b".repeat(64))
                        .contentType("application/json")
                        .content("{\"ownerTreeBytes\":-1}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void restoringAPersistedRootReturnsNoSelectionGrant(@TempDir Path folder) throws Exception {
        String body = "{\"path\":\"" + folder.toString().replace("\\", "\\\\") + "\",\"purpose\":\"RESTORE\"}";
        mvc.perform(post("/api/desktop/paths")
                        .secure(true)
                        .header(HEADER, TOKEN)
                        .header("X-Code-Intelligence-Path-Token", "b".repeat(64))
                        .contentType("application/json")
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.path").value(folder.toRealPath().toString()))
                .andExpect(jsonPath("$.grant").doesNotExist());
        mvc.perform(post("/api/desktop/paths")
                        .secure(true)
                        .header(HEADER, TOKEN)
                        .header("X-Code-Intelligence-Path-Token", "b".repeat(64))
                        .contentType("application/json")
                        .content(body.replace("RESTORE", "OTHER")))
                .andExpect(status().isBadRequest());
    }

    @Configuration(proxyBeanMethods = false)
    @EnableWebMvc
    @Import({
        SecurityConfig.class,
        TestEndpoints.class,
        DesktopPathAuthorizationController.class,
        DesktopPathAuthorizationService.class,
        OwnerTreeMemoryController.class,
        ReportedOwnerTreeMemory.class
    })
    static class TestConfiguration implements WebMvcConfigurer {
        @Override
        public void addResourceHandlers(ResourceHandlerRegistry registry) {
            registry.addResourceHandler("/assets/**").addResourceLocations("classpath:/static/assets/");
        }

        @Bean
        DesktopAuthProperties desktopAuthProperties() {
            return new DesktopAuthProperties(TOKEN, "test", ORIGIN);
        }

        @Bean
        AnalysisMemoryWatchdog analysisMemoryWatchdog(ReportedOwnerTreeMemory memory) {
            return new AnalysisMemoryWatchdog(6L * 1024 * 1024 * 1024, memory, null);
        }

        @Bean
        CorsProperties corsProperties() {
            return new CorsProperties(List.of(ORIGIN));
        }

        @Bean
        AuthProperties authProperties() {
            return new AuthProperties(20, 60);
        }

        @Bean
        GithubOAuth2UserService githubOAuth2UserService() {
            return mock(GithubOAuth2UserService.class);
        }

        @Bean
        AccountService accountService() {
            AccountService accounts = mock(AccountService.class);
            UserAccount user = mock(UserAccount.class);
            when(user.getId()).thenReturn(1L);
            when(user.getLogin()).thenReturn("local");
            when(accounts.getOrCreateLocal("test")).thenReturn(user);
            return accounts;
        }
    }

    @RestController
    static class TestEndpoints {
        private final AtomicInteger mutations = new AtomicInteger();

        @GetMapping({"/", "/api/projects"})
        String read() {
            return "secured";
        }

        @PostMapping("/api/projects")
        String mutate() {
            mutations.incrementAndGet();
            return "secured";
        }
    }
}
