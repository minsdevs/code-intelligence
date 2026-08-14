package dev.codeintelligence.analysis.tree;

import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.AnalyzerEvidence;
import dev.codeintelligence.analysis.core.EdgeConfidence;
import dev.codeintelligence.analysis.core.GraphEdgeDraft;
import dev.codeintelligence.analysis.core.GraphEdgeType;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.GraphNodeType;
import dev.codeintelligence.analysis.core.NaturalKeys;
import dev.codeintelligence.analysis.graph.AreaPathTagger;
import dev.codeintelligence.evidence.EvidenceKind;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

final class TreeGraphMapper {

    private TreeGraphMapper() {}

    static AnalysisResult toGraph(TreeAnalyzeDtos.Response response) {
        List<GraphNodeDraft> nodes = new ArrayList<>();
        List<GraphEdgeDraft> edges = new ArrayList<>();
        List<AnalyzerEvidence> evidences = new ArrayList<>();

        for (TreeAnalyzeDtos.EndpointHit endpoint : response.endpoints()) {
            if (endpoint.method() == null || endpoint.path() == null || endpoint.handlerKey() == null) {
                continue;
            }
            String key = NaturalKeys.endpoint(endpoint.method(), endpoint.path());
            Map<String, Object> metadata = new LinkedHashMap<>();
            metadata.put("httpMethod", endpoint.method());
            metadata.put("path", endpoint.path());
            metadata.put("handlerKey", endpoint.handlerKey());
            nodes.add(new GraphNodeDraft(
                    GraphNodeType.API_ENDPOINT.name(),
                    key,
                    endpoint.method() + " " + endpoint.path(),
                    endpoint.filePath(),
                    endpoint.lineStart(),
                    endpoint.lineEnd(),
                    "BACKEND",
                    metadata));
            if (endpoint.filePath() != null) {
                edges.add(GraphEdgeDraft.of(
                        NaturalKeys.file(endpoint.filePath()), key, GraphEdgeType.EXPOSES, EdgeConfidence.CONFIRMED));
            }
            evidences.add(evidence(
                    key,
                    endpoint.filePath(),
                    endpoint.lineStart(),
                    endpoint.lineEnd(),
                    endpoint.method() + " " + endpoint.path()));
        }

        for (TreeAnalyzeDtos.EntityHit entity : response.entities()) {
            if (entity.name() == null || entity.filePath() == null) {
                continue;
            }
            String key = NaturalKeys.entity(entity.filePath() + "#" + entity.name());
            Map<String, Object> metadata = new LinkedHashMap<>();
            metadata.put("entityName", entity.name());
            metadata.put("tableName", entity.tableName());
            metadata.put("source", entity.source() == null ? "SQLALCHEMY" : entity.source());
            nodes.add(new GraphNodeDraft(
                    GraphNodeType.DB_ENTITY.name(),
                    key,
                    entity.name(),
                    entity.filePath(),
                    entity.lineStart(),
                    null,
                    AreaPathTagger.tag(entity.filePath()),
                    metadata));
            edges.add(GraphEdgeDraft.of(
                    NaturalKeys.file(entity.filePath()), key, GraphEdgeType.CONTAINS, EdgeConfidence.CONFIRMED));
            evidences.add(evidence(
                    key, entity.filePath(), entity.lineStart(), entity.lineStart(), "ENTITY " + entity.name()));
        }

        Map<String, List<TreeAnalyzeDtos.ApiCallHit>> callsByOwner = new LinkedHashMap<>();
        for (TreeAnalyzeDtos.ApiCallHit call : response.apiCalls()) {
            String owner = call.owner() == null ? "" : call.owner();
            callsByOwner.computeIfAbsent(owner, key -> new ArrayList<>()).add(call);
        }
        for (TreeAnalyzeDtos.SymbolHit component : response.components()) {
            addSymbol(nodes, edges, evidences, component, GraphNodeType.COMPONENT, callsByOwner.get(component.name()));
        }
        for (TreeAnalyzeDtos.SymbolHit hook : response.hooks()) {
            addSymbol(nodes, edges, evidences, hook, GraphNodeType.HOOK, callsByOwner.get(hook.name()));
        }
        for (TreeAnalyzeDtos.SymbolHit store : response.stores()) {
            addSymbol(nodes, edges, evidences, store, GraphNodeType.STORE, null);
        }
        for (TreeAnalyzeDtos.RouteHit route : response.routes()) {
            if (route.path() == null || route.path().isBlank()) {
                continue;
            }
            String key = NaturalKeys.route(route.path());
            Map<String, Object> metadata = new LinkedHashMap<>();
            metadata.put("path", route.path());
            if (route.component() != null) {
                metadata.put("componentKey", route.component());
            }
            nodes.add(new GraphNodeDraft(
                    GraphNodeType.FE_ROUTE.name(),
                    key,
                    route.path(),
                    route.filePath(),
                    route.lineStart(),
                    route.lineEnd(),
                    AreaPathTagger.tag(route.filePath()),
                    metadata));
            evidences.add(evidence(key, route.filePath(), route.lineStart(), route.lineEnd(), "Route " + route.path()));
            if (route.filePath() != null) {
                edges.add(GraphEdgeDraft.of(
                        NaturalKeys.file(route.filePath()), key, GraphEdgeType.CONTAINS, EdgeConfidence.CONFIRMED));
            }
        }
        for (TreeAnalyzeDtos.ImportHit imported : response.imports()) {
            if (imported.fromPath() == null || imported.toPath() == null) {
                continue;
            }
            edges.add(GraphEdgeDraft.of(
                    NaturalKeys.file(imported.fromPath()),
                    NaturalKeys.file(imported.toPath()),
                    GraphEdgeType.IMPORTS,
                    EdgeConfidence.CONFIRMED));
        }
        for (TreeAnalyzeDtos.SymbolHit symbol : response.symbols()) {
            if (symbol.name() == null || symbol.filePath() == null) {
                continue;
            }
            GraphNodeType type = "CLASS".equalsIgnoreCase(symbol.kind()) ? GraphNodeType.CLASS : GraphNodeType.METHOD;
            if ("FUNCTION".equalsIgnoreCase(symbol.kind()) && !isTypeName(symbol.name())) {
                type = GraphNodeType.METHOD;
            }
            nodes.add(new GraphNodeDraft(
                    type.name(),
                    NaturalKeys.genericSymbol(symbol.filePath(), symbol.name()),
                    symbol.name(),
                    symbol.filePath(),
                    symbol.lineStart(),
                    symbol.lineEnd(),
                    AreaPathTagger.tag(symbol.filePath()),
                    Map.of("kind", symbol.kind() == null ? "" : symbol.kind())));
        }
        return new AnalysisResult(nodes, edges, evidences);
    }

    private static boolean isTypeName(String name) {
        return name != null && !name.isEmpty() && Character.isUpperCase(name.charAt(0));
    }

    private static void addSymbol(
            List<GraphNodeDraft> nodes,
            List<GraphEdgeDraft> edges,
            List<AnalyzerEvidence> evidences,
            TreeAnalyzeDtos.SymbolHit symbol,
            GraphNodeType type,
            List<TreeAnalyzeDtos.ApiCallHit> calls) {
        if (symbol.name() == null || symbol.filePath() == null) {
            return;
        }
        String key =
                switch (type) {
                    case HOOK -> NaturalKeys.hook(symbol.filePath(), symbol.name());
                    case STORE -> NaturalKeys.store(symbol.filePath(), symbol.name());
                    default -> NaturalKeys.component(symbol.filePath(), symbol.name());
                };
        Map<String, Object> metadata = new LinkedHashMap<>();
        if (calls != null && !calls.isEmpty()) {
            metadata.put(
                    "apiCalls",
                    calls.stream()
                            .map(call -> Map.of(
                                    "method",
                                    call.method() == null
                                            ? "GET"
                                            : call.method().toUpperCase(Locale.ROOT),
                                    "url",
                                    call.url() == null ? "" : call.url(),
                                    "lineStart",
                                    call.lineStart() == null ? 1 : call.lineStart()))
                            .toList());
        }
        nodes.add(new GraphNodeDraft(
                type.name(),
                key,
                symbol.name(),
                symbol.filePath(),
                symbol.lineStart(),
                symbol.lineEnd(),
                AreaPathTagger.tag(symbol.filePath()),
                metadata));
        evidences.add(evidence(
                key, symbol.filePath(), symbol.lineStart(), symbol.lineEnd(), type.name() + " " + symbol.name()));
        edges.add(GraphEdgeDraft.of(
                NaturalKeys.file(symbol.filePath()), key, GraphEdgeType.CONTAINS, EdgeConfidence.CONFIRMED));
    }

    private static AnalyzerEvidence evidence(String key, String path, Integer start, Integer end, String excerpt) {
        return new AnalyzerEvidence(key, EvidenceKind.FILE_LINE, path, start, end, excerpt);
    }
}
