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
    private final HttpClient httpClient;
    private final TsAnalyzerControlClient controlClient;

    public TsAnalyzerClient(TsAnalyzerProperties properties, RestClient.Builder restClientBuilder) {
        this.properties = properties;
        // ADR-01: the packaged desktop reaches the analyzer only through main's control socket.
        this.controlClient = properties.controlled() ? new TsAnalyzerControlClient(properties) : null;
        if (!properties.enabled() || controlClient != null) {
            this.restClient = null;
            this.httpClient = null;
            return;
        }
        this.httpClient = transport(properties).build();
        this.restClient = restClientBuilder
                .clone()
                .baseUrl(properties.baseUrl())
                .requestFactory(requestFactory(timeout()))
                .build();
    }

    private JdkClientHttpRequestFactory requestFactory(Duration readTimeout) {
        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(httpClient);
        factory.setReadTimeout(readTimeout);
        return factory;
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

    /** The configured bound of one analyzer request. */
    public Duration timeout() {
        return Duration.ofSeconds(properties.timeoutSeconds());
    }

    public TsAnalyzeDtos.Response analyze(TsAnalyzeDtos.Request request) {
        return analyze(request, timeout());
    }

    /** Sends one request bounded by {@code timeout} instead of the configured {@link #timeout()}. */
    public TsAnalyzeDtos.Response analyze(TsAnalyzeDtos.Request request, Duration timeout) {
        if (controlClient != null) {
            return controlClient.analyze(request, timeout);
        }
        if (restClient == null) {
            return TsAnalyzeDtos.Response.EMPTY;
        }
        byte[] payload = TsRequestBudget.encode(request);
        RestClient client = timeout.equals(timeout())
                ? restClient
                : restClient.mutate().requestFactory(requestFactory(timeout)).build();
        try {
            TsAnalyzeDtos.Response body = client.post()
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
                        throw TsAnalyzerRejectedException.fromResponse(errorBody);
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
