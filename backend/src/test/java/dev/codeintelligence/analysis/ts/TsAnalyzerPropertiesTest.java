package dev.codeintelligence.analysis.ts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;

class TsAnalyzerPropertiesTest {
    @Test
    void springBinderUsesCanonicalConstructorAndKeepsHttpDefaults() {
        var source = new MapConfigurationPropertySource();
        source.put("app.ts-analyzer.base-url", "https://127.0.0.1:3040");
        source.put("app.ts-analyzer.tls-cert-sha256", PIN);
        source.put("app.ts-analyzer.auth-token", TOKEN);
        var binder = new Binder(source);
        var bound = binder.bind("app.ts-analyzer", Bindable.of(TsAnalyzerProperties.class))
                .get();
        assertThat(bound.pinnedTls()).isTrue();
        assertThat(bound.timeoutSeconds()).isEqualTo(30);
        assertThat(bound.authToken()).isEqualTo(TOKEN);
        var defaults = new Binder(
                        new MapConfigurationPropertySource(Map.of("app.ts-analyzer.base-url", "http://127.0.0.1:3040")))
                .bind("app.ts-analyzer", Bindable.of(TsAnalyzerProperties.class))
                .get();
        assertThat(defaults.pinnedTls()).isFalse();
        assertThat(defaults.authToken()).isEmpty();
        assertThat(defaults.timeoutSeconds()).isEqualTo(30);
    }

    private static final String PIN = "a1".repeat(32);
    private static final String TOKEN = "B2".repeat(32);

    @Test
    void pinsLoopbackOriginsAndPreservesCallerTokenCase() {
        for (String origin : new String[] {"https://127.0.0.1:3040/", "https://[::1]:3040"}) {
            var properties = new TsAnalyzerProperties(origin, 30, PIN.toUpperCase(), TOKEN);
            assertThat(properties.pinnedTls()).isTrue();
            assertThat(properties.tlsCertSha256()).isEqualTo(PIN);
            assertThat(properties.authToken()).isEqualTo(TOKEN);
            assertThat(properties.toString()).doesNotContain(TOKEN, PIN);
        }
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "",
                "http://127.0.0.1:3040",
                "https://localhost:3040",
                "https://ts-analyzer:3040",
                "https://127.0.0.1",
                "https://127.0.0.1:0",
                "https://127.0.0.1:65536",
                "https://127.0.0.1:3040/analyze",
                "https://127.0.0.1:3040/?value=1",
                "https://127.0.0.1:3040/#fragment",
                "https://user@127.0.0.1:3040",
                "https://127.0.0.1:3040//"
            })
    void strictTlsRejectsAmbiguousOrUnpinnedDestinations(String origin) {
        assertThatThrownBy(() -> new TsAnalyzerProperties(origin, 30, PIN, TOKEN))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void httpsAndAnyTlsSettingRequireCompleteWellFormedConfiguration() {
        assertThatThrownBy(() -> new TsAnalyzerProperties("https://127.0.0.1:3040", 30))
                .isInstanceOf(IllegalStateException.class);
        for (String invalid : new String[] {"", " ", "a".repeat(63), "g".repeat(64), TOKEN + "\r\n"}) {
            assertThatThrownBy(() -> new TsAnalyzerProperties("https://127.0.0.1:3040", 30, PIN, invalid))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageNotContaining(TOKEN);
            assertThatThrownBy(() -> new TsAnalyzerProperties("https://127.0.0.1:3040", 30, invalid, TOKEN))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageNotContaining(TOKEN);
        }
    }

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
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new TsAnalyzerProperties("http://192.0.2.1:3040", 30))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("not allowed");
    }

    @Test
    void fileSchemeIsRejected() {
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new TsAnalyzerProperties("file:///etc/passwd", 30))
                .isInstanceOf(IllegalStateException.class);
    }

    private static final String CAPABILITY = "c3".repeat(32);

    @Test
    void desktopControlSocketBindsFromTheEnvironmentAndExcludesTheHttpAnalyzer() {
        var bound = new Binder(new MapConfigurationPropertySource(Map.of(
                        "app.ts-analyzer.control-socket",
                        "/var/folders/xy/T/ci-adapter-AbC123/control.sock",
                        "app.ts-analyzer.control-capability",
                        CAPABILITY)))
                .bind("app.ts-analyzer", Bindable.of(TsAnalyzerProperties.class))
                .get();
        assertThat(bound.enabled()).isTrue();
        assertThat(bound.controlled()).isTrue();
        assertThat(bound.pinnedTls()).isFalse();
        assertThat(bound.toString()).doesNotContain(CAPABILITY).contains("controlled=true");
        assertThat(new TsAnalyzerProperties("http://127.0.0.1:3040", 30).controlled())
                .isFalse();
        for (String[] invalid : new String[][] {
            {"http://127.0.0.1:3040", "", "", "/tmp/c.sock", CAPABILITY},
            {"", PIN, TOKEN, "/tmp/c.sock", CAPABILITY},
            {"", "", "", "relative/c.sock", CAPABILITY},
            {"", "", "", "/tmp/" + "d".repeat(99), CAPABILITY},
            {"", "", "", "/tmp/c\0.sock", CAPABILITY},
            {"", "", "", "/tmp/c.sock", CAPABILITY.toUpperCase()},
            {"", "", "", "/tmp/c.sock", "c3"},
            {"", "", "", "", CAPABILITY},
        }) {
            assertThatThrownBy(() ->
                            new TsAnalyzerProperties(invalid[0], 30, invalid[1], invalid[2], invalid[3], invalid[4]))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageNotContaining(CAPABILITY)
                    .hasMessageNotContaining(TOKEN);
        }
        assertThat(new TsAnalyzerProperties("", 30, "", "", "/tmp/" + "d".repeat(98), CAPABILITY).controlled())
                .isTrue();
    }
}
