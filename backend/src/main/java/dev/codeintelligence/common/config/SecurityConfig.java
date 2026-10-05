package dev.codeintelligence.common.config;

import dev.codeintelligence.auth.AccountService;
import dev.codeintelligence.auth.AuthProperties;
import dev.codeintelligence.auth.DesktopAuthProperties;
import dev.codeintelligence.auth.DesktopAuthenticationFilter;
import dev.codeintelligence.auth.GithubOAuth2UserService;
import dev.codeintelligence.auth.PatLoginRateLimitFilter;
import dev.codeintelligence.maintenance.MaintenanceFilter;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.function.Supplier;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.actuate.info.InfoEndpoint;
import org.springframework.boot.health.actuate.endpoint.HealthEndpoint;
import org.springframework.boot.security.autoconfigure.actuate.web.servlet.EndpointRequest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.security.web.access.AccessDeniedHandlerImpl;
import org.springframework.security.web.authentication.HttpStatusEntryPoint;
import org.springframework.security.web.authentication.SimpleUrlAuthenticationFailureHandler;
import org.springframework.security.web.authentication.SimpleUrlAuthenticationSuccessHandler;
import org.springframework.security.web.authentication.logout.HttpStatusReturningLogoutSuccessHandler;
import org.springframework.security.web.authentication.www.BasicAuthenticationFilter;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.security.web.csrf.CookieCsrfTokenRepository;
import org.springframework.security.web.csrf.CsrfException;
import org.springframework.security.web.csrf.CsrfFilter;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.security.web.csrf.CsrfTokenRequestAttributeHandler;
import org.springframework.security.web.csrf.CsrfTokenRequestHandler;
import org.springframework.security.web.csrf.XorCsrfTokenRequestAttributeHandler;
import org.springframework.security.web.savedrequest.NullRequestCache;
import org.springframework.util.StringUtils;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Phase 1 (§18 carry-over ②③): session-based security backed by Spring Session Redis, CSRF
 * re-enabled with the SPA cookie pattern, CORS restricted to the configured allowlist, and
 * oauth2Login wired only when a GitHub OAuth App is configured (PAT login works without it).
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    SecurityContextRepository securityContextRepository() {
        return new HttpSessionSecurityContextRepository();
    }

    @Bean
    SecurityFilterChain securityFilterChain(
            HttpSecurity http,
            CorsProperties corsProperties,
            AuthProperties authProperties,
            DesktopAuthProperties desktopAuthProperties,
            AccountService accountService,
            SecurityContextRepository securityContextRepository,
            GithubOAuth2UserService githubOAuth2UserService,
            ObjectProvider<ClientRegistrationRepository> clientRegistrations,
            Environment environment)
            throws Exception {
        CookieCsrfTokenRepository csrfTokenRepository = CookieCsrfTokenRepository.withHttpOnlyFalse();
        boolean desktop = environment.acceptsProfiles(Profiles.of("desktop"));
        csrfTokenRepository.setCookieCustomizer(cookie -> {
            cookie.sameSite("Lax");
            if (desktop) cookie.secure(true);
        });

        http.cors(Customizer.withDefaults())
                .csrf(csrf -> csrf.csrfTokenRepository(csrfTokenRepository)
                        .csrfTokenRequestHandler(new SpaCsrfTokenRequestHandler())
                        .ignoringRequestMatchers("/api/desktop/paths")
                        .ignoringRequestMatchers(MaintenanceFilter::isControlRequest))
                .addFilterBefore(
                        new DesktopAuthenticationFilter(desktopAuthProperties, accountService),
                        BasicAuthenticationFilter.class)
                .addFilterAfter(new CsrfCookieFilter(), BasicAuthenticationFilter.class)
                .addFilterAfter(new PatLoginRateLimitFilter(authProperties), CsrfFilter.class)
                .securityContext(context -> context.securityContextRepository(securityContextRepository))
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.IF_REQUIRED))
                .requestCache(cache -> cache.requestCache(new NullRequestCache()))
                .formLogin(AbstractHttpConfigurer::disable)
                .httpBasic(AbstractHttpConfigurer::disable)
                .logout(logout -> logout.logoutUrl("/api/auth/logout")
                        .logoutSuccessHandler(new HttpStatusReturningLogoutSuccessHandler(HttpStatus.NO_CONTENT)))
                .exceptionHandling(
                        handling -> handling.authenticationEntryPoint(new HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED))
                                .accessDeniedHandler(new CsrfProblemAccessDeniedHandler()))
                .authorizeHttpRequests(
                        // ERROR dispatch must be reachable, otherwise sendError(403/…) from
                        // the default denial handler is re-authorized and turned into a 401.
                        auth -> auth.dispatcherTypeMatchers(DispatcherType.ERROR)
                                .permitAll()
                                .requestMatchers(EndpointRequest.to(HealthEndpoint.class, InfoEndpoint.class))
                                .permitAll()
                                .requestMatchers(HttpMethod.GET, "/api/csrf", "/api/auth/me")
                                .permitAll()
                                // Web mode bootstraps publicly; desktop capability protection wraps
                                // the entire servlet chain, including these static resources.
                                .requestMatchers(HttpMethod.GET, "/", "/index.html", "/assets/**", "/vite.svg")
                                .permitAll()
                                .requestMatchers(HttpMethod.POST, "/api/auth/pat")
                                .permitAll()
                                .requestMatchers("/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html")
                                .permitAll()
                                .requestMatchers("/oauth2/**", "/login/oauth2/**")
                                .permitAll()
                                .anyRequest()
                                .authenticated());

        if (clientRegistrations.getIfAvailable() != null) {
            SimpleUrlAuthenticationSuccessHandler successHandler =
                    new SimpleUrlAuthenticationSuccessHandler(corsProperties.frontendOrigin());
            successHandler.setAlwaysUseDefaultTargetUrl(true);
            http.oauth2Login(login -> login.userInfoEndpoint(userInfo -> userInfo.userService(githubOAuth2UserService))
                    .successHandler(successHandler)
                    .failureHandler(new SimpleUrlAuthenticationFailureHandler(
                            corsProperties.frontendOrigin() + "/?oauthError=true")));
        }
        return http.build();
    }

    @Bean
    CorsConfigurationSource corsConfigurationSource(CorsProperties corsProperties) {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowedOrigins(corsProperties.allowedOrigins());
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        config.setAllowedHeaders(List.of(
                HttpHeaders.CONTENT_TYPE,
                HttpHeaders.ACCEPT,
                "X-XSRF-TOKEN",
                "X-Requested-With",
                DesktopAuthenticationFilter.TOKEN_HEADER));
        config.setAllowCredentials(true);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", config);
        return source;
    }

    /** Only a CSRF filter rejection permits the SPA to refresh and resend a mutation. */
    static final class CsrfProblemAccessDeniedHandler implements AccessDeniedHandler {
        private static final String CSRF_PROBLEM = "{\"type\":\"about:blank\",\"title\":\"Forbidden\",\"status\":403,"
                + "\"detail\":\"CSRF token is missing or invalid.\",\"code\":\"CSRF_INVALID\"}";
        private final AccessDeniedHandler delegate = new AccessDeniedHandlerImpl();

        @Override
        public void handle(HttpServletRequest request, HttpServletResponse response, AccessDeniedException exception)
                throws IOException, ServletException {
            if (!(exception instanceof CsrfException)) {
                delegate.handle(request, response, exception);
                return;
            }
            if (response.isCommitted()) return;
            response.setStatus(HttpStatus.FORBIDDEN.value());
            response.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
            response.setCharacterEncoding(StandardCharsets.UTF_8.name());
            response.getWriter().write(CSRF_PROBLEM);
        }
    }

    /**
     * Spring Security SPA pattern: BREACH-protected (xor) rendering, while tokens submitted via
     * the X-XSRF-TOKEN header (copied by JS from the cookie) are resolved as plain values.
     */
    static final class SpaCsrfTokenRequestHandler extends CsrfTokenRequestAttributeHandler {

        private final CsrfTokenRequestHandler delegate = new XorCsrfTokenRequestAttributeHandler();

        @Override
        public void handle(HttpServletRequest request, HttpServletResponse response, Supplier<CsrfToken> csrfToken) {
            delegate.handle(request, response, csrfToken);
        }

        @Override
        public String resolveCsrfTokenValue(HttpServletRequest request, CsrfToken csrfToken) {
            String headerValue = request.getHeader(csrfToken.getHeaderName());
            return (StringUtils.hasText(headerValue)
                    ? super.resolveCsrfTokenValue(request, csrfToken)
                    : delegate.resolveCsrfTokenValue(request, csrfToken));
        }
    }

    /** Forces the deferred CSRF token to load so the XSRF-TOKEN cookie is written when absent. */
    static final class CsrfCookieFilter extends OncePerRequestFilter {

        @Override
        protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
                throws ServletException, IOException {
            CsrfToken csrfToken = (CsrfToken) request.getAttribute("_csrf");
            if (csrfToken != null) {
                csrfToken.getToken();
            }
            chain.doFilter(request, response);
        }
    }
}
