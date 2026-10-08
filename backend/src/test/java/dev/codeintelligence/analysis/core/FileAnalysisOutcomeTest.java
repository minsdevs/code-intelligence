package dev.codeintelligence.analysis.core;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class FileAnalysisOutcomeTest {
    @Test
    void inventoryNeverClaimsParserSuccess() {
        assertThat(FileAnalysisOutcome.initialStatus(file("a.ts", "typescript")))
                .isEqualTo("UNMEASURED");
        assertThat(FileAnalysisOutcome.initialStatus(file("a.java", "java"))).isEqualTo("UNMEASURED");
        assertThat(FileAnalysisOutcome.initialStatus(file("package.json", "json")))
                .isEqualTo("UNMEASURED");
        assertThat(FileAnalysisOutcome.initialStatus(file("a.rs", "rust"))).isEqualTo("UNSUPPORTED");
    }

    private InventoriedFile file(String path, String language) {
        return new InventoriedFile(path, language, 0, 0, "");
    }
}
