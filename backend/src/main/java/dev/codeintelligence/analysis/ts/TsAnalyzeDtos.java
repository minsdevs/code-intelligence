package dev.codeintelligence.analysis.ts;

import java.util.List;
import java.util.Map;

public final class TsAnalyzeDtos {

    private TsAnalyzeDtos() {}

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
            metadata = metadata == null ? Map.of() : Map.copyOf(metadata);
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
            metadata = metadata == null ? Map.of() : Map.copyOf(metadata);
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
            metadata = metadata == null ? Map.of() : Map.copyOf(metadata);
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
            List<UnresolvedCallHit> unresolvedCalls) {

        public static final Response EMPTY = new Response(
                List.of(), List.of(), List.of(), List.of(), List.of(), List.of(), List.of(), List.of(), List.of(),
                List.of(), List.of());

        public Response {
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
