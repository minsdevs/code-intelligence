package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.lang.syntax.ArchRuleDefinition;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.RestClient;

/**
 * G-COST entry-point guard (backend). Provider HTTP clients exist only in the two legacy browser-mode
 * providers; in the desktop product the factory returns a metadata-only provider whose every network
 * method throws, so the only provider egress is main's gateway reached through an approved RequestPlan.
 */
class AiProviderEgressArchitectureTest {
    private static final JavaClasses CLASSES = new ClassFileImporter()
            .withImportOption(new ImportOption.DoNotIncludeTests())
            .importPackages("dev.codeintelligence");

    @Test
    void outboundHttpClientsAreLimitedToTheReviewedInventory() {
        ArchRuleDefinition.noClasses()
                .that()
                .doNotHaveFullyQualifiedName("dev.codeintelligence.ai.OpenAIProvider")
                .and()
                .doNotHaveFullyQualifiedName("dev.codeintelligence.ai.GeminiProvider")
                .and()
                .doNotHaveFullyQualifiedName("dev.codeintelligence.ai.AIProviderConfig")
                .and()
                .resideOutsideOfPackages("dev.codeintelligence.github..", "dev.codeintelligence.auth..")
                .and()
                .doNotHaveFullyQualifiedName("dev.codeintelligence.analysis.ts.TsAnalyzerClient")
                .and()
                .doNotHaveFullyQualifiedName("dev.codeintelligence.analysis.tree.TreeAnalyzerClient")
                .and()
                .doNotHaveFullyQualifiedName("dev.codeintelligence.common.web.ApiExceptionHandler")
                .should()
                .dependOnClassesThat()
                .haveFullyQualifiedName(RestClient.class.getName())
                .orShould()
                .dependOnClassesThat()
                .haveFullyQualifiedName("java.net.http.HttpClient")
                .orShould()
                .dependOnClassesThat()
                .haveFullyQualifiedName("java.net.HttpURLConnection")
                .orShould()
                .dependOnClassesThat()
                .haveFullyQualifiedName("java.net.Socket")
                .orShould()
                .dependOnClassesThat()
                .haveFullyQualifiedName("org.springframework.web.reactive.function.client.WebClient")
                .because("provider egress must stay behind the reviewed gateway inventory (G-COST)")
                .check(CLASSES);
        ArchRuleDefinition.noClasses()
                .that()
                .resideInAPackage("dev.codeintelligence.ai..")
                .and()
                .doNotHaveFullyQualifiedName("dev.codeintelligence.ai.OpenAIProvider")
                .and()
                .doNotHaveFullyQualifiedName("dev.codeintelligence.ai.GeminiProvider")
                .should()
                .callMethodWhere(com.tngtech.archunit.core.domain.JavaCall.Predicates.target(
                        com.tngtech.archunit.core.domain.properties.HasOwner.Predicates.With.owner(
                                com.tngtech.archunit.base.DescribedPredicate.describe(
                                        "RestClient", c -> c.getName().equals(RestClient.class.getName())))))
                .check(CLASSES);
    }

    @Test
    void networkProvidersAreConstructedOnlyByTheFactoryAndCalledOnlyThroughGuardedPaths() {
        ArchRuleDefinition.noClasses()
                .that()
                .doNotHaveFullyQualifiedName("dev.codeintelligence.ai.AIProviderConfig")
                .and()
                .doNotHaveFullyQualifiedName("dev.codeintelligence.ai.OpenAIProvider")
                .and()
                .doNotHaveFullyQualifiedName("dev.codeintelligence.ai.GeminiProvider")
                .should()
                .callConstructorWhere(com.tngtech.archunit.core.domain.JavaCall.Predicates.target(
                        com.tngtech.archunit.base.DescribedPredicate.describe(
                                "a network provider constructor",
                                target -> target.getOwner().isEquivalentTo(OpenAIProvider.class)
                                        || target.getOwner().isEquivalentTo(GeminiProvider.class))))
                .check(CLASSES);
        for (String method : List.of("chat", "stream", "embed", "testConnection")) {
            ArchRuleDefinition.noClasses()
                    .that()
                    .doNotHaveFullyQualifiedName("dev.codeintelligence.ai.AiUsageService")
                    .and()
                    .doNotHaveFullyQualifiedName("dev.codeintelligence.ai.AiSettingsService")
                    .and()
                    .haveNameNotMatching("dev\\.codeintelligence\\.ai\\.AIProviderConfig(\\$.*)?")
                    .and()
                    .areNotAssignableTo(AIProvider.class)
                    .should()
                    .callMethodWhere(com.tngtech.archunit.core.domain.JavaCall.Predicates.target(
                            com.tngtech.archunit.base.DescribedPredicate.describe(
                                    "AIProvider." + method,
                                    target -> target.getName().equals(method)
                                            && target.getOwner().isAssignableTo(AIProvider.class))))
                    .because("provider calls must pass the RequestPlan/settings-revision guards")
                    .check(CLASSES);
        }
    }

    @Test
    void desktopFactoryNeverBuildsAProviderHttpClient() {
        AiMainGatewayClient main = mock(AiMainGatewayClient.class);
        when(main.enabled()).thenReturn(true);
        RestClient.Builder forbidden = mock(RestClient.Builder.class, invocation -> {
            throw new AssertionError("Desktop mode must not touch a provider HTTP client");
        });
        AIProviderFactory factory = new AIProviderConfig().aiProviderFactory(null, forbidden, null, main);
        for (String name : List.of("openai", "gemini", "anthropic")) {
            AIProvider provider =
                    factory.create(name, "sk-publicSyntheticArchitectureKey0123456789", AiDesktopGateway.MODEL);
            assertThat(provider.enabled()).isEqualTo("openai".equals(name));
            assertThatThrownBy(provider::testConnection).isInstanceOf(AiRequestPlanRequiredException.class);
            assertThatThrownBy(() -> provider.chat(new AIProvider.ChatRequest("s", "u", true)))
                    .isInstanceOf(AiRequestPlanRequiredException.class);
            assertThatThrownBy(() -> provider.stream(new AIProvider.ChatRequest("s", "u", true), token -> {}))
                    .isInstanceOf(AiRequestPlanRequiredException.class);
            assertThatThrownBy(() -> provider.embed("u")).isInstanceOf(AiRequestPlanRequiredException.class);
        }
        // The legacy un-approved usage path is closed in every mode.
        AiUsageService usage = new AiUsageService(null, null);
        assertThatThrownBy(() -> usage.chat(1, 1, null, "review", null))
                .isInstanceOf(AiRequestPlanRequiredException.class);
        assertThatThrownBy(usage::requireRequestPlan).isInstanceOf(AiRequestPlanRequiredException.class);
    }

    @Test
    void providerHostsAppearOnlyInThePropertyAllowlist() throws IOException {
        Map<String, Long> owners = new TreeMap<>();
        try (var files = Files.walk(Path.of("src/main"))) {
            for (Path file : files.filter(Files::isRegularFile).toList()) {
                String text = Files.readString(file);
                for (String host : List.of(
                        "api.openai.com", "generativelanguage.googleapis.com", "api.anthropic.com", "api.mistral.ai"))
                    if (text.contains(host)) owners.merge(file.toString().replace('\\', '/'), 1L, Long::sum);
            }
        }
        assertThat(owners.keySet())
                .containsExactly(
                        "src/main/java/dev/codeintelligence/ai/AiProperties.java",
                        "src/main/resources/application.yml");
    }
}
