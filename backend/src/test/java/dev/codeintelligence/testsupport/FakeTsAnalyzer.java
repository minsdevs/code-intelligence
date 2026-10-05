package dev.codeintelligence.testsupport;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import tools.jackson.databind.json.JsonMapper;

/**
 * In-process ts-analyzer stand-in. Regex extraction covers fixture React Router + fetch; the real
 * sidecar is covered by analyzers/ts-analyzer npm tests.
 */
public final class FakeTsAnalyzer implements AutoCloseable {

    private static final Pattern ROUTE = Pattern.compile("path\\s*=\\s*\"([^\"]+)\"");
    private static final Pattern ELEMENT = Pattern.compile("element\\s*=\\s*\\{\\s*<\\s*([A-Z][A-Za-z0-9]*)");
    private static final Pattern FETCH = Pattern.compile("fetch\\(\\s*[\"']([^\"']+)[\"']");
    private static final Pattern EXPORT_FN = Pattern.compile("export function ([A-Za-z_][A-Za-z0-9]*)");
    private static final Pattern IMPORT =
            Pattern.compile("import\\s+(?:\\{([^}]+)\\}|([A-Za-z_][A-Za-z0-9]*))\\s+from\\s+[\"']([^\"']+)[\"']");

    private final HttpServer server;
    private final JsonMapper json = JsonMapper.builder().build();

    public FakeTsAnalyzer() {
        try {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        server.createContext("/health", this::handleHealth);
        server.createContext("/analyze", this::handleAnalyze);
        server.start();
    }

    public String baseUrl() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @Override
    public void close() {
        server.stop(0);
    }

    private void handleHealth(HttpExchange exchange) throws IOException {
        respond(exchange, 200, "{\"status\":\"ok\"}");
    }

    private void handleAnalyze(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"method\"}");
            return;
        }
        String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        @SuppressWarnings("unchecked")
        Map<String, Object> request = json.readValue(body, Map.class);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> files = (List<Map<String, Object>>) request.getOrDefault("files", List.of());
        List<Map<String, Object>> routes = new ArrayList<>();
        List<Map<String, Object>> components = new ArrayList<>();
        List<Map<String, Object>> apiCalls = new ArrayList<>();
        List<Map<String, Object>> imports = new ArrayList<>();
        Set<String> paths =
                files.stream().map(file -> String.valueOf(file.get("path"))).collect(Collectors.toSet());
        for (Map<String, Object> file : files) {
            String path = String.valueOf(file.get("path"));
            String content = String.valueOf(file.getOrDefault("content", ""));
            extractRoutes(path, content, routes);
            extractComponents(path, content, components);
            extractFetch(path, content, apiCalls);
            extractImports(path, content, paths, imports);
        }
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("routes", routes);
        response.put("components", components);
        response.put("hooks", List.of());
        response.put("stores", List.of());
        response.put("apiCalls", apiCalls);
        response.put("imports", imports);
        response.put("symbols", List.of());
        respond(exchange, 200, json.writeValueAsString(response));
    }

    private static void extractRoutes(String path, String content, List<Map<String, Object>> routes) {
        Matcher matcher = ROUTE.matcher(content);
        while (matcher.find()) {
            String routePath = matcher.group(1);
            if (!routePath.startsWith("/")) {
                routePath = "/" + routePath;
            }
            int line = lineOf(content, matcher.start());
            String component = nearbyElement(content, matcher.start());
            Map<String, Object> hit = new LinkedHashMap<>();
            hit.put("path", routePath);
            hit.put("component", component);
            hit.put("filePath", path);
            hit.put("lineStart", line);
            hit.put("lineEnd", line);
            routes.add(hit);
        }
    }

    private static String nearbyElement(String content, int at) {
        int end = Math.min(content.length(), at + 120);
        Matcher matcher = ELEMENT.matcher(content.substring(at, end));
        return matcher.find() ? matcher.group(1) : null;
    }

    private static void extractComponents(String path, String content, List<Map<String, Object>> components) {
        Matcher matcher = EXPORT_FN.matcher(content);
        while (matcher.find()) {
            String name = matcher.group(1);
            if (name.startsWith("use") || Character.isLowerCase(name.charAt(0))) {
                continue;
            }
            if (!content.contains("<")) {
                continue;
            }
            int line = lineOf(content, matcher.start());
            Map<String, Object> hit = new LinkedHashMap<>();
            hit.put("name", name);
            hit.put("kind", "COMPONENT");
            hit.put("filePath", path);
            hit.put("lineStart", line);
            hit.put("lineEnd", line);
            components.add(hit);
        }
    }

    private static void extractFetch(String path, String content, List<Map<String, Object>> apiCalls) {
        Matcher matcher = FETCH.matcher(content);
        while (matcher.find()) {
            int line = lineOf(content, matcher.start());
            Map<String, Object> hit = new LinkedHashMap<>();
            hit.put("method", "GET");
            hit.put("url", matcher.group(1));
            hit.put("filePath", path);
            hit.put("lineStart", line);
            hit.put("owner", ownerAt(content, matcher.start()));
            apiCalls.add(hit);
        }
    }

    private static void extractImports(
            String path, String content, Set<String> paths, List<Map<String, Object>> imports) {
        Matcher matcher = IMPORT.matcher(content);
        while (matcher.find()) {
            String spec = matcher.group(3);
            if (spec == null || !spec.startsWith(".")) {
                continue;
            }
            String base =
                    Path.of(path).resolveSibling(spec).normalize().toString().replace('\\', '/');
            String target = List.of("", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx").stream()
                    .map(suffix -> base + suffix)
                    .filter(paths::contains)
                    .findFirst()
                    .orElse(null);
            if (target == null) {
                continue;
            }
            boolean named = matcher.group(1) != null;
            String imported = named ? matcher.group(1) : matcher.group(2);
            if (imported == null) {
                continue;
            }
            for (String name : imported.split(",")) {
                String[] binding = name.strip().split("\\s+as\\s+");
                String exportedName = named ? binding[0].strip() : "default";
                String localName = binding[binding.length - 1].strip();
                if (binding.length > 2
                        || !exportedName.matches("[A-Za-z_$][A-Za-z0-9_$]*")
                        || !localName.matches("[A-Za-z_$][A-Za-z0-9_$]*")) {
                    continue;
                }
                Map<String, Object> hit = new LinkedHashMap<>();
                hit.put("fromPath", path);
                hit.put("toPath", target);
                hit.put("imported", localName);
                hit.put("importedName", exportedName);
                hit.put("typeOnly", false);
                imports.add(hit);
            }
        }
    }

    private static String ownerAt(String content, int at) {
        Matcher matcher = EXPORT_FN.matcher(content);
        String last = null;
        while (matcher.find() && matcher.start() < at) {
            last = matcher.group(1);
        }
        return last;
    }

    private static int lineOf(String content, int index) {
        int line = 1;
        for (int i = 0; i < index && i < content.length(); i++) {
            if (content.charAt(i) == '\n') {
                line++;
            }
        }
        return line;
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
