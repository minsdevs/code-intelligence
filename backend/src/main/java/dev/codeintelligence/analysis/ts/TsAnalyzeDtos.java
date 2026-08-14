package dev.codeintelligence.analysis.ts;

import java.util.List;

public final class TsAnalyzeDtos {

    private TsAnalyzeDtos() {}

    public record FilePayload(String path, String content) {}

    public record Request(List<FilePayload> files) {}

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

    public record Response(
            List<RouteHit> routes,
            List<SymbolHit> components,
            List<SymbolHit> hooks,
            List<SymbolHit> stores,
            List<ApiCallHit> apiCalls,
            List<ImportHit> imports,
            List<SymbolHit> symbols,
            List<EndpointHit> endpoints) {

        public static final Response EMPTY =
                new Response(List.of(), List.of(), List.of(), List.of(), List.of(), List.of(), List.of(), List.of());

        public Response {
            routes = routes == null ? List.of() : List.copyOf(routes);
            components = components == null ? List.of() : List.copyOf(components);
            hooks = hooks == null ? List.of() : List.copyOf(hooks);
            stores = stores == null ? List.of() : List.copyOf(stores);
            apiCalls = apiCalls == null ? List.of() : List.copyOf(apiCalls);
            imports = imports == null ? List.of() : List.copyOf(imports);
            symbols = symbols == null ? List.of() : List.copyOf(symbols);
            endpoints = endpoints == null ? List.of() : List.copyOf(endpoints);
        }
    }
}
