package dev.codeintelligence.project;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.common.AnalysisProperties;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.io.ClassPathResource;

class ShippedAnalysisLimitsTest {

    /**
     * The user's size-class decision: the large class (50,000 files / 200 MiB) must be admitted.
     * The shipped admission equals the local preview hard limit (doc 05 §4: 50,000 files / 512 MiB).
     */
    @Test
    void shippedAdmissionReachesThePreviewHardLimit() throws Exception {
        StandardEnvironment environment = new StandardEnvironment();
        new YamlPropertySourceLoader()
                .load("application", new ClassPathResource("application.yml"))
                .forEach(environment.getPropertySources()::addLast);
        AnalysisProperties shipped = Binder.get(environment).bindOrCreate("app.analysis", AnalysisProperties.class);
        AnalysisProperties defaults =
                Binder.get(new StandardEnvironment()).bindOrCreate("app.analysis", AnalysisProperties.class);

        assertThat(shipped.maxFiles()).isEqualTo(50_000);
        assertThat(defaults.maxFiles()).isEqualTo(50_000);
        LocalSourcePolicy.Limits limits = LocalSourcePolicy.Limits.defaults(shipped);
        assertThat(limits.files()).isEqualTo(50_000);
        assertThat(limits.discoveredFiles()).isEqualTo(50_000);
        assertThat(limits.totalBytes()).isEqualTo(512L * 1024 * 1024);
    }
}
