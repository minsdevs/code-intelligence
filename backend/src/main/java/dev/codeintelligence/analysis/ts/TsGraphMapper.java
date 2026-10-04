package dev.codeintelligence.analysis.ts;

import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.AnalyzerEvidence;
import dev.codeintelligence.analysis.core.EdgeConfidence;
import dev.codeintelligence.analysis.core.GraphEdgeDraft;
import dev.codeintelligence.analysis.core.GraphEdgeType;
import dev.codeintelligence.analysis.core.GraphIdentityGuard;
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

final class TsGraphMapper {

    private TsGraphMapper() {}

    static AnalysisResult toGraph(TsAnalyzeDtos.Response response) {
        List<GraphNodeDraft> nodes = new ArrayList<>();
        List<GraphEdgeDraft> edges = new ArrayList<>();
        List<AnalyzerEvidence> evidences = new ArrayList<>();
        Map<String, List<TsAnalyzeDtos.ApiCallHit>> callsByOwner = new LinkedHashMap<>();
        Map<String, List<Map<String, Object>>> unresolvedBySource = new LinkedHashMap<>();
        for (TsAnalyzeDtos.UnresolvedCallHit unresolved : response.unresolvedCalls()) {
            if (unresolved.sourceKey() == null || unresolved.expression() == null) {
                continue;
            }
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("expression", unresolved.expression());
            if (unresolved.filePath() != null) {
                detail.put("filePath", unresolved.filePath());
            }
            if (unresolved.lineStart() != null) {
                detail.put("lineStart", unresolved.lineStart());
            }
            if (unresolved.reason() != null) {
                detail.put("reason", unresolved.reason());
            }
            unresolvedBySource
                    .computeIfAbsent(unresolved.sourceKey(), key -> new ArrayList<>())
                    .add(detail);
        }
        for (TsAnalyzeDtos.ApiCallHit call : response.apiCalls()) {
            String owner = call.owner() == null ? "" : call.owner();
            callsByOwner
                    .computeIfAbsent(ownerIdentity(call.filePath(), owner), key -> new ArrayList<>())
                    .add(call);
        }
        for (TsAnalyzeDtos.SymbolHit component : response.components()) {
            addSymbol(
                    nodes,
                    edges,
                    evidences,
                    component,
                    GraphNodeType.COMPONENT,
                    callsByOwner.get(ownerIdentity(component.filePath(), component.name())));
        }
        for (TsAnalyzeDtos.SymbolHit hook : response.hooks()) {
            addSymbol(
                    nodes,
                    edges,
                    evidences,
                    hook,
                    GraphNodeType.HOOK,
                    callsByOwner.get(ownerIdentity(hook.filePath(), hook.name())));
        }
        for (TsAnalyzeDtos.SymbolHit store : response.stores()) {
            addSymbol(nodes, edges, evidences, store, GraphNodeType.STORE, null);
        }
        for (TsAnalyzeDtos.RouteHit route : response.routes()) {
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
            if (route.component() != null && route.filePath() != null) {
                TsAnalyzeDtos.SymbolHit component = routeComponent(response, route.component(), route.filePath());
                if (component != null) {
                    String componentKey = NaturalKeys.component(component.filePath(), component.name());
                    edges.add(GraphEdgeDraft.of(key, componentKey, GraphEdgeType.CONTAINS, EdgeConfidence.LIKELY));
                }
            }
        }
        for (TsAnalyzeDtos.EndpointHit endpoint : response.endpoints()) {
            if (endpoint.method() == null || endpoint.path() == null || endpoint.handlerKey() == null) {
                continue;
            }
            String key = NaturalKeys.endpoint(endpoint.method(), endpoint.path());
            Map<String, Object> metadata = new LinkedHashMap<>(endpoint.metadata());
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
            if (endpoint.ownerKey() != null && !endpoint.ownerKey().isBlank()) {
                edges.add(GraphEdgeDraft.of(endpoint.ownerKey(), key, GraphEdgeType.EXPOSES, EdgeConfidence.CONFIRMED));
            } else if (endpoint.filePath() != null) {
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
        for (TsAnalyzeDtos.ImportHit imported : response.imports()) {
            if (imported.fromPath() == null || imported.toPath() == null) {
                continue;
            }
            Map<String, Object> metadata = new LinkedHashMap<>();
            metadata.put("typeOnly", Boolean.TRUE.equals(imported.typeOnly()));
            if (imported.imported() != null) {
                metadata.put("localName", imported.imported());
            }
            if (imported.importedName() != null) {
                metadata.put("importedName", imported.importedName());
            }
            edges.add(new GraphEdgeDraft(
                    NaturalKeys.file(imported.fromPath()),
                    NaturalKeys.file(imported.toPath()),
                    GraphEdgeType.IMPORTS.name(),
                    EdgeConfidence.CONFIRMED.name(),
                    metadata));
        }
        for (TsAnalyzeDtos.SymbolHit symbol : response.symbols()) {
            if (symbol.name() == null || symbol.filePath() == null) {
                continue;
            }
            GraphNodeType type = "CLASS".equalsIgnoreCase(symbol.kind()) ? GraphNodeType.CLASS : GraphNodeType.METHOD;
            String key = NaturalKeys.genericSymbol(symbol.filePath(), symbol.name());
            nodes.add(new GraphNodeDraft(
                    type.name(),
                    key,
                    symbol.name(),
                    symbol.filePath(),
                    symbol.lineStart(),
                    symbol.lineEnd(),
                    AreaPathTagger.tag(symbol.filePath()),
                    Map.of("kind", symbol.kind() == null ? "" : symbol.kind())));
        }
        for (TsAnalyzeDtos.SemanticNodeHit node : response.nodes()) {
            if (node.key() == null
                    || node.key().isBlank()
                    || node.type() == null
                    || node.type().isBlank()) {
                continue;
            }
            Map<String, Object> metadata = new LinkedHashMap<>(node.metadata());
            List<Map<String, Object>> unresolved = unresolvedBySource.get(node.key());
            if (unresolved != null && !unresolved.isEmpty()) {
                metadata.put("unresolvedCalls", unresolved);
            }
            nodes.add(new GraphNodeDraft(
                    node.type(),
                    node.key(),
                    node.name() == null ? node.key() : node.name(),
                    node.filePath(),
                    node.lineStart(),
                    node.lineEnd(),
                    node.layer() == null ? AreaPathTagger.tag(node.filePath()) : node.layer(),
                    metadata));
            if (node.filePath() != null) {
                evidences.add(evidence(
                        node.key(),
                        node.filePath(),
                        node.lineStart(),
                        node.lineEnd(),
                        node.type() + " " + (node.name() == null ? node.key() : node.name())));
            }
        }
        for (TsAnalyzeDtos.SemanticEdgeHit semanticEdge : response.edges()) {
            if (semanticEdge.sourceKey() == null || semanticEdge.targetKey() == null || semanticEdge.type() == null) {
                continue;
            }
            Map<String, Object> metadata = new LinkedHashMap<>(semanticEdge.metadata());
            if (semanticEdge.filePath() != null) {
                metadata.put("filePath", semanticEdge.filePath());
            }
            if (semanticEdge.lineStart() != null) {
                metadata.put("lineStart", semanticEdge.lineStart());
            }
            if (semanticEdge.lineEnd() != null) {
                metadata.put("lineEnd", semanticEdge.lineEnd());
            }
            edges.add(new GraphEdgeDraft(
                    semanticEdge.sourceKey(),
                    semanticEdge.targetKey(),
                    semanticEdge.type(),
                    confidence(semanticEdge.confidence()).name(),
                    metadata));
        }
        return GraphIdentityGuard.sanitize(new AnalysisResult(nodes, edges, evidences, response.fileOutcomes()));
    }

    private static void addSymbol(
            List<GraphNodeDraft> nodes,
            List<GraphEdgeDraft> edges,
            List<AnalyzerEvidence> evidences,
            TsAnalyzeDtos.SymbolHit symbol,
            GraphNodeType type,
            List<TsAnalyzeDtos.ApiCallHit> calls) {
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

    private static String ownerIdentity(String filePath, String name) {
        return (filePath == null ? "" : filePath) + "#" + name;
    }

    private static TsAnalyzeDtos.SymbolHit routeComponent(
            TsAnalyzeDtos.Response response, String name, String routeFile) {
        var local = response.components().stream()
                .filter(hit -> name.equals(hit.name()) && routeFile.equals(hit.filePath()))
                .toList();
        if (local.size() == 1) return local.getFirst();
        if (!local.isEmpty()) return null;
        // A name alone does not identify a module. Follow only an observed import binding.
        var imported = response.imports().stream()
                .filter(hit -> routeFile.equals(hit.fromPath()) && name.equals(hit.imported()))
                .flatMap(binding -> response.components().stream()
                        .filter(hit -> binding.toPath() != null
                                && binding.toPath().equals(hit.filePath())
                                && hit.name().equals(binding.importedName())))
                .distinct()
                .toList();
        return imported.size() == 1 ? imported.getFirst() : null;
    }

    private static EdgeConfidence confidence(String raw) {
        if (raw == null) {
            return EdgeConfidence.POSSIBLE;
        }
        try {
            return EdgeConfidence.valueOf(raw.toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException ignored) {
            return EdgeConfidence.POSSIBLE;
        }
    }

    private static AnalyzerEvidence evidence(String key, String path, Integer start, Integer end, String excerpt) {
        return new AnalyzerEvidence(key, EvidenceKind.FILE_LINE, path, start, end, excerpt);
    }
}
