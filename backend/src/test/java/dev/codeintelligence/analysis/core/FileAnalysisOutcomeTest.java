package dev.codeintelligence.analysis.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;

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

    @Test
    void missingOrDuplicateSidecarOutcomeIsUnmeasured() {
        JdbcClient jdbc = mock(JdbcClient.class);
        JdbcClient.StatementSpec statement = mock(JdbcClient.StatementSpec.class, RETURNS_SELF);
        when(jdbc.sql(anyString())).thenReturn(statement);
        FileAnalysisOutcome.recordResponse(
                jdbc,
                12,
                List.of("a.ts", "b.ts"),
                List.of(
                        new FileAnalysisOutcome("a.ts", "SUCCESS", "TS_PARSED"),
                        new FileAnalysisOutcome("a.ts", "SUCCESS", "TS_PARSED")));
        verify(statement, times(2)).param("status", "UNMEASURED");
        verify(statement, never()).param("status", "SUCCESS");
    }

    @Test
    void onlySubmittedPathsAndBoundedReasonCodesAreRecorded() {
        JdbcClient jdbc = mock(JdbcClient.class);
        JdbcClient.StatementSpec statement = mock(JdbcClient.StatementSpec.class, RETURNS_SELF);
        when(jdbc.sql(anyString())).thenReturn(statement);
        FileAnalysisOutcome.recordResponse(
                jdbc,
                12,
                List.of("a.ts"),
                List.of(
                        new FileAnalysisOutcome("a.ts", "PARTIAL", "source text must not be stored"),
                        new FileAnalysisOutcome("other.ts", "SUCCESS", "TS_PARSED")));
        verify(statement).param("status", "PARTIAL");
        verify(statement).param("reason", "PARSER_REPORTED");
        verify(statement, never()).param("path", "other.ts");
    }

    private InventoriedFile file(String path, String language) {
        return new InventoriedFile(path, language, 0, 0, "");
    }
}
