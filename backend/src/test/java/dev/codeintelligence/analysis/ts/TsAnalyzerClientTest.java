package dev.codeintelligence.analysis.ts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.codeintelligence.testsupport.FakeTsAnalyzer;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.RestClient;

class TsAnalyzerClientTest {

    @Test
    void analyzeRoundTripsFixtureShapedFiles() {
        try (FakeTsAnalyzer fake = new FakeTsAnalyzer()) {
            TsAnalyzerClient client =
                    new TsAnalyzerClient(new TsAnalyzerProperties(fake.baseUrl(), 10), RestClient.builder());
            TsAnalyzeDtos.Response response = client.analyze(new TsAnalyzeDtos.Request(List.of(
                    new TsAnalyzeDtos.FilePayload("src/App.tsx", """
                            export function App() {
                              return <Route path="/todos" element={<TodosPage />} />;
                            }
                            """),
                    new TsAnalyzeDtos.FilePayload("src/pages/TodosPage.tsx", """
                            export function TodosPage() {
                              fetch("/api/todos");
                              return <div />;
                            }
                            """))));
            assertThat(response.routes())
                    .extracting(TsAnalyzeDtos.RouteHit::path)
                    .contains("/todos");
            assertThat(response.components())
                    .extracting(TsAnalyzeDtos.SymbolHit::name)
                    .contains("TodosPage");
            assertThat(response.apiCalls())
                    .extracting(TsAnalyzeDtos.ApiCallHit::url)
                    .contains("/api/todos");
        }
    }

    @Test
    void downSidecarFails() {
        TsAnalyzerClient client =
                new TsAnalyzerClient(new TsAnalyzerProperties("http://127.0.0.1:1", 2), RestClient.builder());
        assertThatThrownBy(() -> client.health()).isInstanceOf(TsAnalyzerException.class);
    }
}
