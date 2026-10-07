package dev.codeintelligence.analysis.ts;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

class TsLanguageCapabilitiesTest {

    @Test
    void expectedDepthFollowsTheAdaptersThisInstallationRuns() {
        TsAnalyzerClient client = Mockito.mock(TsAnalyzerClient.class);
        var capabilities = new TsLanguageCapabilities(client);

        Mockito.when(client.enabled()).thenReturn(false);
        assertThat(capabilities.expectedDepth("java")).isEqualTo("SYMBOLS_AND_CALLS");
        assertThat(capabilities.expectedDepth("typescript")).isEqualTo("INVENTORY_ONLY");
        assertThat(capabilities.expectedDepth("python")).isEqualTo("INVENTORY_ONLY");
        assertThat(capabilities.expectedDepth("gradle")).isEqualTo("CONFIGURATION");
        assertThat(capabilities.expectedDepth("markdown")).isEqualTo("INVENTORY_ONLY");

        Mockito.when(client.enabled()).thenReturn(true);
        assertThat(capabilities.expectedDepth("javascript")).isEqualTo("SYMBOLS_AND_CALLS");
        assertThat(capabilities.expectedDepth("go")).isEqualTo("STRUCTURE");
        assertThat(capabilities.expectedDepth("dockerfile")).isEqualTo("CONFIGURATION");
    }
}
