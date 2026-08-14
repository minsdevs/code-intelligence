package dev.codeintelligence.evidence;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class SecretMaskTest {

    @Test
    void redactsGithubPatsAndAssignmentValues() {
        assertThat(SecretMask.redact("token=ghp_abcdefghijklmnopqrstuvwxyz012345"))
                .contains("[REDACTED]")
                .doesNotContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
        assertThat(SecretMask.redact("password: super-secret")).isEqualTo("password: [REDACTED]");
        assertThat(SecretMask.redact("AKIAIOSFODNN7EXAMPLE")).isEqualTo("[REDACTED]");
        assertThat(SecretMask.redact("sk-abcdefghijklmnopqrstuvwxyz012345")).isEqualTo("[REDACTED]");
        assertThat(SecretMask.redact("class Todo {}")).isEqualTo("class Todo {}");
        assertThat(SecretMask.redact(null)).isNull();
    }
}
