package dev.codeintelligence.analysis.ts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.codeintelligence.testsupport.FakeTsAnalyzer;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentMatchers;
import org.mockito.Mockito;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.test.web.client.match.MockRestRequestMatchers;
import org.springframework.test.web.client.response.MockRestResponseCreators;
import org.springframework.web.client.RestClient;

class TsAnalyzerClientTest {
    @Test
    void pinnedTransportUsesTheCallerHeaderForHealthAndAnalysis() {
        var builder = Mockito.spy(RestClient.builder());
        var server = MockRestServiceServer.bindTo(builder).build();
        // Only the HTTP exchange is replaced; production header/body construction remains under test.
        Mockito.doReturn(builder).when(builder).clone();
        Mockito.doReturn(builder).when(builder).requestFactory(ArgumentMatchers.any());
        String token = "b2".repeat(32);
        var client = new TsAnalyzerClient(
                new TsAnalyzerProperties("https://127.0.0.1:3040", 2, "a1".repeat(32), token), builder);
        server.expect(MockRestRequestMatchers.requestTo("https://127.0.0.1:3040/health"))
                .andExpect(MockRestRequestMatchers.header("Authorization", "Bearer " + token))
                .andRespond(MockRestResponseCreators.withSuccess());
        server.expect(MockRestRequestMatchers.requestTo("https://127.0.0.1:3040/analyze"))
                .andExpect(MockRestRequestMatchers.header("Authorization", "Bearer " + token))
                .andExpect(MockRestRequestMatchers.content().string("{\"files\":[]}"))
                .andRespond(MockRestResponseCreators.withSuccess("{}", MediaType.APPLICATION_JSON));
        client.health();
        client.analyze(new TsAnalyzeDtos.Request(List.of()));
        server.verify();
    }

    @Test
    void pinnedTransportDoesNotRetainReflectedTokensOrSourceInExceptionCauses() {
        var builder = Mockito.spy(RestClient.builder());
        var server = MockRestServiceServer.bindTo(builder).build();
        Mockito.doReturn(builder).when(builder).clone();
        Mockito.doReturn(builder).when(builder).requestFactory(ArgumentMatchers.any());
        String token = "b2".repeat(32);
        var client = new TsAnalyzerClient(
                new TsAnalyzerProperties("https://127.0.0.1:3040", 2, "a1".repeat(32), token), builder);
        server.expect(MockRestRequestMatchers.anything())
                .andRespond(MockRestResponseCreators.withServerError().body(token + " source marker"));
        server.expect(MockRestRequestMatchers.anything())
                .andRespond(MockRestResponseCreators.withServerError().body(token + " source marker"));
        assertThatThrownBy(client::health)
                .isInstanceOf(TsAnalyzerException.class)
                .hasMessage("ts-analyzer health failed")
                .hasNoCause();
        assertThatThrownBy(() -> client.analyze(new TsAnalyzeDtos.Request(List.of())))
                .isInstanceOf(TsAnalyzerException.class)
                .hasMessage("ts-analyzer request failed")
                .hasNoCause();
        server.verify();
    }

    @Test
    void anAnalyzerRejectionWithoutSyntaxDiagnosticsNamesItsCode() {
        var builder = Mockito.spy(RestClient.builder());
        var server = MockRestServiceServer.bindTo(builder).build();
        Mockito.doReturn(builder).when(builder).clone();
        Mockito.doReturn(builder).when(builder).requestFactory(ArgumentMatchers.any());
        var client = new TsAnalyzerClient(new TsAnalyzerProperties("http://127.0.0.1:3040", 2), builder);
        server.expect(MockRestRequestMatchers.anything())
                .andRespond(MockRestResponseCreators.withBadRequest()
                        .contentType(MediaType.APPLICATION_JSON)
                        .body("{\"statusCode\":400,\"code\":\"SESSION_UNKNOWN\",\"message\":\"source marker\","
                                + "\"retryable\":false}"));
        assertThatThrownBy(() -> client.analyze(new TsAnalyzeDtos.Request(List.of())))
                .isInstanceOf(dev.codeintelligence.common.RecoveryActionFailure.class)
                .hasNoCause()
                .hasMessage("ts-analyzer rejected the analysis request (SESSION_UNKNOWN)")
                .satisfies(
                        error -> assertThat(((dev.codeintelligence.common.RecoveryActionFailure) error).failureCode())
                                .isEqualTo("TS_ANALYZER_REJECTED"));
        server.verify();
    }

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
