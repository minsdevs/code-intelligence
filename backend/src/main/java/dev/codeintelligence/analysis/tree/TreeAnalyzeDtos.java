package dev.codeintelligence.analysis.tree;

import com.fasterxml.jackson.annotation.JsonInclude;
import dev.codeintelligence.analysis.core.FileAnalysisOutcome;
import java.util.List;

public final class TreeAnalyzeDtos {

    private TreeAnalyzeDtos() {}

    public record FilePayload(
            String path,
            String content,
            @JsonInclude(JsonInclude.Include.NON_NULL) String cache) {
        public FilePayload(String path, String content) {
            this(path, content, null);
        }
    }

    public record Request(
            List<FilePayload> files,
            @JsonInclude(JsonInclude.Include.NON_NULL) List<String> localPaths,
            @JsonInclude(JsonInclude.Include.NON_NULL) String cacheKey) {
        public Request(List<FilePayload> files) {
            this(files, null, null);
        }
    }

    public record RouteHit(String path, String component, String filePath, Integer lineStart, Integer lineEnd) {}

    public record SymbolHit(String name, String kind, String filePath, Integer lineStart, Integer lineEnd) {}

    public record ApiCallHit(String method, String url, String filePath, Integer lineStart, String owner) {}

    public record ImportHit(String fromPath, String toPath, String imported) {}

    public record EndpointHit(
            String method,
            String path,
            String handlerKey,
            String handler,
            String filePath,
            Integer lineStart,
            Integer lineEnd) {}

    public record EntityHit(String name, String tableName, String source, String filePath, Integer lineStart) {}

    public record Response(
            List<RouteHit> routes,
            List<SymbolHit> components,
            List<SymbolHit> hooks,
            List<SymbolHit> stores,
            List<ApiCallHit> apiCalls,
            List<ImportHit> imports,
            List<SymbolHit> symbols,
            List<EndpointHit> endpoints,
            List<EntityHit> entities,
            List<FileAnalysisOutcome> fileOutcomes,
            @JsonInclude(JsonInclude.Include.NON_EMPTY) List<String> cache) {
        public Response(
                List<RouteHit> routes,
                List<SymbolHit> components,
                List<SymbolHit> hooks,
                List<SymbolHit> stores,
                List<ApiCallHit> apiCalls,
                List<ImportHit> imports,
                List<SymbolHit> symbols,
                List<EndpointHit> endpoints,
                List<EntityHit> entities,
                List<FileAnalysisOutcome> fileOutcomes) {
            this(
                    routes,
                    components,
                    hooks,
                    stores,
                    apiCalls,
                    imports,
                    symbols,
                    endpoints,
                    entities,
                    fileOutcomes,
                    List.of());
        }

        public Response(
                List<RouteHit> routes,
                List<SymbolHit> components,
                List<SymbolHit> hooks,
                List<SymbolHit> stores,
                List<ApiCallHit> apiCalls,
                List<ImportHit> imports,
                List<SymbolHit> symbols,
                List<EndpointHit> endpoints,
                List<EntityHit> entities) {
            this(routes, components, hooks, stores, apiCalls, imports, symbols, endpoints, entities, List.of());
        }

        public static final Response EMPTY = new Response(
                List.of(), List.of(), List.of(), List.of(), List.of(), List.of(), List.of(), List.of(), List.of());

        public Response {
            cache = cache == null ? List.of() : List.copyOf(cache);
            fileOutcomes = fileOutcomes == null ? List.of() : List.copyOf(fileOutcomes);
            routes = routes == null ? List.of() : List.copyOf(routes);
            components = components == null ? List.of() : List.copyOf(components);
            hooks = hooks == null ? List.of() : List.copyOf(hooks);
            stores = stores == null ? List.of() : List.copyOf(stores);
            apiCalls = apiCalls == null ? List.of() : List.copyOf(apiCalls);
            imports = imports == null ? List.of() : List.copyOf(imports);
            symbols = symbols == null ? List.of() : List.copyOf(symbols);
            endpoints = endpoints == null ? List.of() : List.copyOf(endpoints);
            entities = entities == null ? List.of() : List.copyOf(entities);
        }
    }
}
