package dev.codeintelligence.analysis.ts;

import java.net.http.HttpClient;
import java.time.Duration;
import javax.net.ssl.SSLParameters;
import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

@Component
public class TsAnalyzerClient {

    private final TsAnalyzerProperties properties;
    private final RestClient restClient;
    private final TsAnalyzerControlClient controlClient;

    public TsAnalyzerClient(TsAnalyzerProperties properties, RestClient.Builder restClientBuilder) {
        this.properties = properties;
        // ADR-01: the packaged desktop reaches the analyzer only through main's control socket.
        this.controlClient = properties.controlled() ? new TsAnalyzerControlClient(properties) : null;
        if (!properties.enabled() || controlClient != null) {
            this.restClient = null;
            return;
        }
        HttpClient httpClient = transport(properties).build();
        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(httpClient);
        factory.setReadTimeout(Duration.ofSeconds(properties.timeoutSeconds()));
        this.restClient = restClientBuilder
                .clone()
                .baseUrl(properties.baseUrl())
                .requestFactory(factory)
                .build();
    }

    static HttpClient.Builder transport(TsAnalyzerProperties properties) {
        HttpClient.Builder builder = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(Math.min(5, properties.timeoutSeconds())))
                .followRedirects(HttpClient.Redirect.NEVER);
        if (properties.pinnedTls()) {
            SSLParameters parameters = new SSLParameters();
            parameters.setProtocols(new String[] {"TLSv1.3", "TLSv1.2"});
            parameters.setEndpointIdentificationAlgorithm("HTTPS");
            builder.sslContext(TsAnalyzerTls.context(properties))
                    .sslParameters(parameters)
                    .proxy(HttpClient.Builder.NO_PROXY);
        }
        return builder;
    }

    public boolean enabled() {
        return properties.enabled();
    }

    public TsAnalyzeDtos.Response analyze(TsAnalyzeDtos.Request request) {
        if (controlClient != null) {
            return controlClient.analyze(request);
        }
        if (restClient == null) {
            return TsAnalyzeDtos.Response.EMPTY;
        }
        byte[] payload = TsRequestBudget.encode(request);
        try {
            TsAnalyzeDtos.Response body = restClient
                    .post()
                    .uri("/analyze")
                    .headers(headers -> {
                        if (properties.pinnedTls()) headers.setBearerAuth(properties.authToken());
                    })
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(payload)
                    .retrieve()
                    .onStatus(status -> status.value() == 400, (requestIgnored, response) -> {
                        byte[] errorBody = response.getBody().readNBytes(TsSyntaxInputException.MAX_ERROR_BYTES + 1);
                        TsSyntaxInputException syntax = TsSyntaxInputException.fromResponse(errorBody);
                        if (syntax != null) throw syntax;
                        throw new TsAnalyzerException(
                                "ts-analyzer rejected input without a recognized diagnostic", null);
                    })
                    .body(TsAnalyzeDtos.Response.class);
            return body == null ? TsAnalyzeDtos.Response.EMPTY : body;
        } catch (RestClientException e) {
            throw new TsAnalyzerException("ts-analyzer request failed", properties.pinnedTls() ? null : e);
        }
    }

    public void health() {
        if (controlClient != null) {
            controlClient.health();
            return;
        }
        if (restClient == null) {
            return;
        }
        try {
            restClient
                    .get()
                    .uri("/health")
                    .headers(headers -> {
                        if (properties.pinnedTls()) headers.setBearerAuth(properties.authToken());
                    })
                    .retrieve()
                    .toBodilessEntity();
        } catch (RestClientException e) {
            throw new TsAnalyzerException("ts-analyzer health failed", properties.pinnedTls() ? null : e);
        }
    }
}
