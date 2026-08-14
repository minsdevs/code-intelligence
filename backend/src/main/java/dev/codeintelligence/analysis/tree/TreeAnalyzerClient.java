package dev.codeintelligence.analysis.tree;

import java.net.http.HttpClient;
import java.time.Duration;
import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

@Component
public class TreeAnalyzerClient {

    private final TreeAnalyzerProperties properties;
    private final RestClient restClient;

    public TreeAnalyzerClient(TreeAnalyzerProperties properties, RestClient.Builder restClientBuilder) {
        this.properties = properties;
        if (!properties.enabled()) {
            this.restClient = null;
            return;
        }
        HttpClient httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(Math.min(5, properties.timeoutSeconds())))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(httpClient);
        factory.setReadTimeout(Duration.ofSeconds(properties.timeoutSeconds()));
        this.restClient = restClientBuilder
                .clone()
                .baseUrl(properties.baseUrl())
                .requestFactory(factory)
                .build();
    }

    public boolean enabled() {
        return properties.enabled();
    }

    public TreeAnalyzeDtos.Response analyze(TreeAnalyzeDtos.Request request) {
        if (restClient == null) {
            return TreeAnalyzeDtos.Response.EMPTY;
        }
        try {
            TreeAnalyzeDtos.Response body = restClient
                    .post()
                    .uri("/analyze")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(request)
                    .retrieve()
                    .body(TreeAnalyzeDtos.Response.class);
            return body == null ? TreeAnalyzeDtos.Response.EMPTY : body;
        } catch (RestClientException e) {
            throw new TreeAnalyzerException("tree-analyzer request failed", e);
        }
    }

    public void health() {
        if (restClient == null) {
            return;
        }
        try {
            restClient.get().uri("/health").retrieve().toBodilessEntity();
        } catch (RestClientException e) {
            throw new TreeAnalyzerException("tree-analyzer health failed", e);
        }
    }
}
