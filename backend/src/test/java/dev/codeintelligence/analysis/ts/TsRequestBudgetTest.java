package dev.codeintelligence.analysis.ts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Collections;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class TsRequestBudgetTest {
    @Test
    void encodesUtf8AndEscapedSourceAsTheExactWireBody() {
        var request =
                new TsAnalyzeDtos.Request(List.of(new TsAnalyzeDtos.FilePayload("한글.ts", "const v = \"\\n\";\n")));
        byte[] body = TsRequestBudget.encode(request);
        assertThat(JsonMapper.builder().build().readValue(body, TsAnalyzeDtos.Request.class))
                .isEqualTo(request);
    }

    @Test
    void countsJsonEscapesAndRejectsManySmallFilesBeforeSending() {
        var file = new TsAnalyzeDtos.FilePayload("fixture.ts", "\u0001".repeat(1_000_000));
        assertThatThrownBy(() -> TsRequestBudget.encode(new TsAnalyzeDtos.Request(List.of(file, file))))
                .isInstanceOf(TsAnalyzerException.class)
                .hasMessageContaining("10 MiB");
        var empty = new TsAnalyzeDtos.FilePayload("fixture.ts", "");
        assertThatThrownBy(() -> TsRequestBudget.encode(new TsAnalyzeDtos.Request(Collections.nCopies(20_001, empty))))
                .isInstanceOf(TsAnalyzerException.class)
                .hasMessageContaining("20000-file");
    }
}
