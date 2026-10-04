package dev.codeintelligence.analysis.ts;

import dev.codeintelligence.analysis.core.FileAnalysisOutcome;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public final class TsAnalyzeDtos {

    private TsAnalyzeDtos() {}

    /**
     * Analyzer metadata uses JSON null for unknown optional fields (e.g. an inferred return
     * type). Omit those top-level fields at the graph boundary, whose immutable maps reject
     * null values. Preserve nested parameter positions and their explicit unknown types.
     */
    private static Map<String, Object> immutableMetadata(Map<String, Object> metadata) {
        if (metadata == null) return Map.of();
        Map<String, Object> copy = new LinkedHashMap<>();
        metadata.forEach((key, value) -> {
            Objects.requireNonNull(key);
            if (value != null) copy.put(key, value);
        });
        return Map.copyOf(copy);
    }

    public record FilePayload(String path, String content) {}

    public record Request(List<FilePayload> files) {}

    public record RouteHit(String path, String component, String filePath, Integer lineStart, Integer lineEnd) {}

    public record SymbolHit(String name, String kind, String filePath, Integer lineStart, Integer lineEnd) {}

    public record ApiCallHit(String method, String url, String filePath, Integer lineStart, String owner) {}

    public record ImportHit(String fromPath, String toPath, String imported, String importedName, Boolean typeOnly) {}

    public record EndpointHit(
            String method,
            String path,
            String handlerKey,
            String handler,
            String ownerKey,
            String filePath,
            Integer lineStart,
            Integer lineEnd,
            Map<String, Object> metadata) {

        public EndpointHit {
            metadata = immutableMetadata(metadata);
        }
    }

    public record SemanticNodeHit(
            String key,
            String type,
            String name,
            String filePath,
            Integer lineStart,
            Integer lineEnd,
            String layer,
            Map<String, Object> metadata) {

        public SemanticNodeHit {
            metadata = immutableMetadata(metadata);
        }
    }

    public record SemanticEdgeHit(
            String sourceKey,
            String targetKey,
            String type,
            String confidence,
            String filePath,
            Integer lineStart,
            Integer lineEnd,
            Map<String, Object> metadata) {

        public SemanticEdgeHit {
            metadata = immutableMetadata(metadata);
        }
    }

    public record UnresolvedCallHit(
            String sourceKey, String expression, String filePath, Integer lineStart, String reason) {}

    public record Response(
            List<RouteHit> routes,
            List<SymbolHit> components,
            List<SymbolHit> hooks,
            List<SymbolHit> stores,
            List<ApiCallHit> apiCalls,
            List<ImportHit> imports,
            List<SymbolHit> symbols,
            List<EndpointHit> endpoints,
            List<SemanticNodeHit> nodes,
            List<SemanticEdgeHit> edges,
            List<UnresolvedCallHit> unresolvedCalls,
            List<FileAnalysisOutcome> fileOutcomes) {
        public Response(
                List<RouteHit> routes,
                List<SymbolHit> components,
                List<SymbolHit> hooks,
                List<SymbolHit> stores,
                List<ApiCallHit> apiCalls,
                List<ImportHit> imports,
                List<SymbolHit> symbols,
                List<EndpointHit> endpoints,
                List<SemanticNodeHit> nodes,
                List<SemanticEdgeHit> edges,
                List<UnresolvedCallHit> unresolvedCalls) {
            this(
                    routes,
                    components,
                    hooks,
                    stores,
                    apiCalls,
                    imports,
                    symbols,
                    endpoints,
                    nodes,
                    edges,
                    unresolvedCalls,
                    List.of());
        }

        public static final Response EMPTY = new Response(
                List.of(), List.of(), List.of(), List.of(), List.of(), List.of(), List.of(), List.of(), List.of(),
                List.of(), List.of());

        public Response {
            fileOutcomes = fileOutcomes == null ? List.of() : List.copyOf(fileOutcomes);
            routes = routes == null ? List.of() : List.copyOf(routes);
            components = components == null ? List.of() : List.copyOf(components);
            hooks = hooks == null ? List.of() : List.copyOf(hooks);
            stores = stores == null ? List.of() : List.copyOf(stores);
            apiCalls = apiCalls == null ? List.of() : List.copyOf(apiCalls);
            imports = imports == null ? List.of() : List.copyOf(imports);
            symbols = symbols == null ? List.of() : List.copyOf(symbols);
            endpoints = endpoints == null ? List.of() : List.copyOf(endpoints);
            nodes = nodes == null ? List.of() : List.copyOf(nodes);
            edges = edges == null ? List.of() : List.copyOf(edges);
            unresolvedCalls = unresolvedCalls == null ? List.of() : List.copyOf(unresolvedCalls);
        }
    }
}
