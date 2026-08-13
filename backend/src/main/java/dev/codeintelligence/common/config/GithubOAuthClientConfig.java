package dev.codeintelligence.common.config;

import dev.codeintelligence.github.GithubOAuthProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Condition;
import org.springframework.context.annotation.ConditionContext;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.core.type.AnnotatedTypeMetadata;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.registration.InMemoryClientRegistrationRepository;
import org.springframework.security.oauth2.core.AuthorizationGrantType;
import org.springframework.security.oauth2.core.ClientAuthenticationMethod;
import org.springframework.util.StringUtils;

/**
 * OAuth is optional (PAT login is the first-class fallback): the ClientRegistrationRepository
 * only exists when both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are set, and oauth2Login is
 * wired into the filter chain only when this bean is present.
 */
@Configuration(proxyBeanMethods = false)
@Conditional(GithubOAuthClientConfig.GithubOAuthConfiguredCondition.class)
public class GithubOAuthClientConfig {

    @Bean
    ClientRegistrationRepository clientRegistrationRepository(GithubOAuthProperties properties) {
        ClientRegistration registration = ClientRegistration.withRegistrationId("github")
                .clientId(properties.clientId())
                .clientSecret(properties.clientSecret())
                .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
                .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                .redirectUri("{baseUrl}/{action}/oauth2/code/{registrationId}")
                .scope("read:user", "repo")
                .authorizationUri("https://github.com/login/oauth/authorize")
                .tokenUri("https://github.com/login/oauth/access_token")
                .userInfoUri("https://api.github.com/user")
                .userNameAttributeName("id")
                .clientName("GitHub")
                .build();
        return new InMemoryClientRegistrationRepository(registration);
    }

    static class GithubOAuthConfiguredCondition implements Condition {

        @Override
        public boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata) {
            Environment environment = context.getEnvironment();
            return StringUtils.hasText(environment.getProperty("app.github.oauth.client-id"))
                    && StringUtils.hasText(environment.getProperty("app.github.oauth.client-secret"));
        }
    }
}
