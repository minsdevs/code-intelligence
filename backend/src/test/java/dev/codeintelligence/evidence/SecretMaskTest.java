package dev.codeintelligence.evidence;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class SecretMaskTest {

    @Test
    void redactsEntirePrivateKeyIncludingTruncatedBlocks() {
        String key = "-----BEGIN RSA PRIVATE KEY-----\nfixture-key-material\n-----END RSA PRIVATE KEY-----";
        assertThat(SecretMask.redact("before\n" + key + "\nafter")).isEqualTo("before\n[REDACTED]\nafter");
        assertThat(SecretMask.redact("-----BEGIN PRIVATE KEY-----\nfixture-truncated-key"))
                .isEqualTo("[REDACTED]");
    }

    @Test
    void redactsQuotedJsonAndYamlCredentialsWithSpaces() {
        assertThat(SecretMask.redact("{\"api_key\": \"fixture secret with spaces\", \"name\": \"public\"}"))
                .contains("[REDACTED]", "public")
                .doesNotContain("fixture secret", "with spaces");
        assertThat(SecretMask.redact("password: 'fixture secret value'\nname: public"))
                .isEqualTo("password: [REDACTED]\nname: public");
        assertThat(SecretMask.redact("token = \"fixture \\\"escaped\\\" value\"; next();"))
                .isEqualTo("token = [REDACTED]; next();");
    }

    @Test
    void redactsPasswordsInConnectionUriUserinfo() {
        assertThat(SecretMask.redact("db = \"postgresql://ci_user:fixture-db-password@db.example.invalid:5432/app\";"))
                .isEqualTo("db = \"postgresql://ci_user:[REDACTED]@db.example.invalid:5432/app\";");
        assertThat(SecretMask.redact("redis://:fixture-redis-password@cache.example.invalid:6379/0"))
                .isEqualTo("redis://:[REDACTED]@cache.example.invalid:6379/0");
        assertThat(SecretMask.redact("mongodb+srv://app:fixture%40pw@cluster.example.invalid/db"))
                .isEqualTo("mongodb+srv://app:[REDACTED]@cluster.example.invalid/db");
        // Ports, user-only userinfo and ordinary URLs stay readable.
        assertThat(SecretMask.redact("http://localhost:8080/path?q=1")).isEqualTo("http://localhost:8080/path?q=1");
        assertThat(SecretMask.redact("ssh://git@github.com/org/repo.git"))
                .isEqualTo("ssh://git@github.com/org/repo.git");
    }

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
