package dev.codeintelligence.analysis.ts;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.NaturalKeys;
import dev.codeintelligence.testsupport.FakeTsAnalyzer;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/** The fake must speak the current binding DTO; it is not an independent semantic oracle. */
class FakeTsAnalyzerContractTest {
    @Test
    void namedAliasResolvesOnlyItsObservedModuleEvenWithAnUnrelatedSameNamedComponent() throws Exception {
        var result = analyze("import { Page as Selected } from './Page';\n"
                + "export function Router() { return <Route path=\"/\" element={<Selected />} />; }");
        assertThat(result.imports())
                .containsExactly(
                        new TsAnalyzeDtos.ImportHit("app/Router.tsx", "app/Page.tsx", "Selected", "Page", false));
        assertThat(TsGraphMapper.toGraph(result).edges())
                .filteredOn(edge -> edge.sourceNaturalKey().equals(NaturalKeys.route("/")))
                .extracting(edge -> edge.targetNaturalKey())
                .containsExactly(NaturalKeys.component("app/Page.tsx", "Page"));
    }

    @Test
    void absentModuleCannotBeReplacedWithAnUnrelatedSameNamedComponent() throws Exception {
        var result = analyze("import { Page } from './absent';\n"
                + "export function Router() { return <Route path=\"/\" element={<Page />} />; }");
        assertThat(result.imports()).isEmpty();
        assertThat(TsGraphMapper.toGraph(result).edges())
                .noneMatch(edge -> edge.sourceNaturalKey().equals(NaturalKeys.route("/")));
    }

    private TsAnalyzeDtos.Response analyze(String router) throws Exception {
        var json = JsonMapper.builder().build();
        try (var fake = new FakeTsAnalyzer();
                var http = HttpClient.newBuilder()
                        .connectTimeout(Duration.ofSeconds(5))
                        .build()) {
            var request = new TsAnalyzeDtos.Request(List.of(
                    new TsAnalyzeDtos.FilePayload("app/Router.tsx", router),
                    new TsAnalyzeDtos.FilePayload("app/Page.tsx", "export function Page() { return <h1>App</h1>; }"),
                    new TsAnalyzeDtos.FilePayload(
                            "admin/Page.tsx", "export function Page() { return <h1>Admin</h1>; }")));
            var response = http.send(
                    HttpRequest.newBuilder(URI.create(fake.baseUrl() + "/analyze"))
                            .timeout(Duration.ofSeconds(5))
                            .header("Content-Type", "application/json")
                            .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(request)))
                            .build(),
                    HttpResponse.BodyHandlers.ofString());
            assertThat(response.statusCode()).isEqualTo(200);
            return json.readValue(response.body(), TsAnalyzeDtos.Response.class);
        }
    }
}
