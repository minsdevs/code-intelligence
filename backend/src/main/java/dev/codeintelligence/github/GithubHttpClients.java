package dev.codeintelligence.github;

import java.net.http.HttpClient;
import java.time.Duration;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/** GitHub API/device exchanges use bounded transport and never follow credential-bearing redirects. */
@Component
public final class GithubHttpClients {
    public static RestClient.Builder bounded(RestClient.Builder original) {
        var client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
        var factory = new JdkClientHttpRequestFactory(client);
        factory.setReadTimeout(Duration.ofSeconds(15));
        return original.clone().requestFactory(factory);
    }
}
