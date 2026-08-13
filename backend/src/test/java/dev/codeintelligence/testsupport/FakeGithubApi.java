package dev.codeintelligence.testsupport;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

/**
 * Minimal in-process GitHub API stand-in for integration tests (no real GitHub calls, no extra
 * dependencies). Serves GET /user and GET /user/repos for {@link #VALID_TOKEN} only.
 */
public final class FakeGithubApi implements AutoCloseable {

    public static final String VALID_TOKEN = "ghp_integration-valid-token";
    public static final long USER_GITHUB_ID = 424242L;

    private final HttpServer server;

    public FakeGithubApi() {
        try {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        server.createContext("/user", this::handleUser);
        server.createContext("/user/repos", this::handleRepos);
        server.start();
    }

    public String baseUrl() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @Override
    public void close() {
        server.stop(0);
    }

    private void handleUser(HttpExchange exchange) throws IOException {
        if (!authorized(exchange)) {
            respond(exchange, 401, "{\"message\":\"Bad credentials\"}");
            return;
        }
        exchange.getResponseHeaders().add("X-OAuth-Scopes", "repo, read:user");
        addRateLimitHeaders(exchange);
        respond(exchange, 200, """
                {"id":424242,"login":"octocat","name":"Octo Cat",
                 "avatar_url":"https://avatars.test/octocat.png"}""");
    }

    private void handleRepos(HttpExchange exchange) throws IOException {
        if (!authorized(exchange)) {
            respond(exchange, 401, "{\"message\":\"Bad credentials\"}");
            return;
        }
        addRateLimitHeaders(exchange);
        if (pageParam(exchange.getRequestURI().getQuery()) > 1) {
            respond(exchange, 200, "[]");
            return;
        }
        exchange.getResponseHeaders().add("Link", "<" + baseUrl() + "/user/repos?page=2>; rel=\"next\"");
        respond(exchange, 200, """
                [{"name":"alpha-service","full_name":"octocat/alpha-service","private":true,
                  "default_branch":"main","description":"Private service",
                  "updated_at":"2026-08-01T12:00:00Z","owner":{"login":"octocat"}},
                 {"name":"beta-app","full_name":"octocat/beta-app","private":false,
                  "default_branch":"develop","description":"Public app",
                  "updated_at":"2026-07-15T09:30:00Z","owner":{"login":"octocat"}}]""");
    }

    private boolean authorized(HttpExchange exchange) {
        String authorization = exchange.getRequestHeaders().getFirst("Authorization");
        return ("Bearer " + VALID_TOKEN).equals(authorization);
    }

    private void addRateLimitHeaders(HttpExchange exchange) {
        exchange.getResponseHeaders().add("x-ratelimit-remaining", "4999");
        exchange.getResponseHeaders().add("x-ratelimit-reset", "1755100000");
    }

    private static int pageParam(String query) {
        if (query == null) {
            return 1;
        }
        for (String part : query.split("&")) {
            if (part.startsWith("page=")) {
                return Integer.parseInt(part.substring("page=".length()));
            }
        }
        return 1;
    }

    private void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }
}
