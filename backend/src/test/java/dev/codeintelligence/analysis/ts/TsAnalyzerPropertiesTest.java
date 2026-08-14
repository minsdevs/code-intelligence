package dev.codeintelligence.analysis.ts;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class TsAnalyzerPropertiesTest {

    @Test
    void blankUrlDisablesSidecar() {
        TsAnalyzerProperties properties = new TsAnalyzerProperties("", 30);
        assertThat(properties.enabled()).isFalse();
        assertThat(properties.baseUrl()).isEmpty();
    }

    @Test
    void loopbackHttpIsAllowed() {
        TsAnalyzerProperties properties = new TsAnalyzerProperties("http://127.0.0.1:3040/", 15);
        assertThat(properties.enabled()).isTrue();
        assertThat(properties.baseUrl()).isEqualTo("http://127.0.0.1:3040");
    }

    @Test
    void composeServiceNameIsAllowed() {
        TsAnalyzerProperties properties = new TsAnalyzerProperties("http://ts-analyzer:3040", 30);
        assertThat(properties.enabled()).isTrue();
    }

    @Test
    void publicHostIsRejected() {
        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> new TsAnalyzerProperties("http://example.com:3040", 30))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("not allowed");
    }

    @Test
    void fileSchemeIsRejected() {
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new TsAnalyzerProperties("file:///etc/passwd", 30))
                .isInstanceOf(IllegalStateException.class);
    }
}
