package dev.codeintelligence.analysis.feature;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Walks EXPOSES reverse (endpoint → controller) then CALLS at depth ≤ 3 from controller methods,
 * and USES_TYPE to ENTITY/DB_ENTITY. Roles: API / SERVICE / DATA.
 */
final class FeatureLinkBuilder {

    static final int CALLS_DEPTH = 3;

    record GraphNode(long id, String nodeType, String naturalKey, String name, String filePath, String layer) {}

    record GraphEdge(long sourceId, long targetId, String edgeType) {}

    record Link(long nodeId, String role, String name, String filePath) {}

    private final Map<Long, GraphNode> nodesById;
    private final Map<String, GraphNode> nodesByKey;
    private final Map<Long, List<GraphEdge>> out;
    private final Map<Long, List<GraphEdge>> in;

    FeatureLinkBuilder(List<GraphNode> nodes, List<GraphEdge> edges) {
        this.nodesById = new LinkedHashMap<>();
        this.nodesByKey = new LinkedHashMap<>();
        for (GraphNode node : nodes) {
            nodesById.put(node.id(), node);
            nodesByKey.put(node.naturalKey(), node);
        }
        this.out = new HashMap<>();
        this.in = new HashMap<>();
        for (GraphEdge edge : edges) {
            out.computeIfAbsent(edge.sourceId(), key -> new ArrayList<>()).add(edge);
            in.computeIfAbsent(edge.targetId(), key -> new ArrayList<>()).add(edge);
        }
    }

    List<Link> linksFor(Set<String> seedKeys) {
        Set<Long> included = new HashSet<>();
        for (String key : seedKeys) {
            GraphNode node = nodesByKey.get(key);
            if (node != null) {
                included.add(node.id());
            }
        }
        Set<Long> endpoints = new HashSet<>();
        for (Long id : Set.copyOf(included)) {
            GraphNode node = nodesById.get(id);
            if (node != null && "API_ENDPOINT".equals(node.nodeType())) {
                endpoints.add(id);
            }
        }
        Set<Long> controllers = new HashSet<>();
        for (Long endpointId : endpoints) {
            for (GraphEdge edge : in.getOrDefault(endpointId, List.of())) {
                if ("EXPOSES".equals(edge.edgeType())) {
                    controllers.add(edge.sourceId());
                    included.add(edge.sourceId());
                }
            }
        }
        Set<Long> methods = new HashSet<>();
        for (Long controllerId : controllers) {
            for (GraphEdge edge : out.getOrDefault(controllerId, List.of())) {
                if ("DECLARES".equals(edge.edgeType())) {
                    GraphNode declared = nodesById.get(edge.targetId());
                    if (declared != null && "METHOD".equals(declared.nodeType())) {
                        methods.add(declared.id());
                    }
                }
            }
        }
        walkCalls(methods, included);
        expandOwnersAndEntities(included);
        List<Link> links = new ArrayList<>();
        Set<Long> seen = new HashSet<>();
        for (Long id : included) {
            GraphNode node = nodesById.get(id);
            if (node == null || !seen.add(id)) {
                continue;
            }
            String role = roleOf(node);
            if (role == null) {
                continue;
            }
            links.add(new Link(node.id(), role, node.name(), node.filePath()));
        }
        return links;
    }

    private void walkCalls(Set<Long> startMethods, Set<Long> included) {
        ArrayDeque<long[]> queue = new ArrayDeque<>();
        Set<Long> visitedMethods = new HashSet<>();
        for (Long methodId : startMethods) {
            queue.add(new long[] {methodId, 0});
        }
        while (!queue.isEmpty()) {
            long[] item = queue.removeFirst();
            long methodId = item[0];
            int depth = (int) item[1];
            if (!visitedMethods.add(methodId)) {
                continue;
            }
            included.add(methodId);
            if (depth >= CALLS_DEPTH) {
                continue;
            }
            for (GraphEdge edge : out.getOrDefault(methodId, List.of())) {
                if (!"CALLS".equals(edge.edgeType())) {
                    continue;
                }
                queue.add(new long[] {edge.targetId(), depth + 1});
            }
        }
    }

    private void expandOwnersAndEntities(Set<Long> included) {
        Set<Long> extra = new HashSet<>();
        for (Long id : Set.copyOf(included)) {
            GraphNode node = nodesById.get(id);
            if (node == null) {
                continue;
            }
            if ("METHOD".equals(node.nodeType())) {
                for (GraphEdge edge : in.getOrDefault(id, List.of())) {
                    if ("DECLARES".equals(edge.edgeType())) {
                        extra.add(edge.sourceId());
                    }
                }
            }
            for (GraphEdge edge : out.getOrDefault(id, List.of())) {
                if (!"USES_TYPE".equals(edge.edgeType())) {
                    continue;
                }
                GraphNode target = nodesById.get(edge.targetId());
                if (target != null && isData(target)) {
                    extra.add(target.id());
                }
            }
        }
        included.addAll(extra);
        for (GraphNode node : nodesById.values()) {
            if (!"DB_ENTITY".equals(node.nodeType()) || node.filePath() == null) {
                continue;
            }
            for (Long id : Set.copyOf(included)) {
                GraphNode other = nodesById.get(id);
                if (other != null
                        && "ENTITY".equals(other.layer())
                        && node.filePath().equals(other.filePath())) {
                    included.add(node.id());
                    break;
                }
            }
        }
    }

    private static boolean isData(GraphNode node) {
        return "DB_ENTITY".equals(node.nodeType())
                || "ENTITY".equals(node.layer())
                || "REPOSITORY".equals(node.layer());
    }

    private static String roleOf(GraphNode node) {
        if ("API_ENDPOINT".equals(node.nodeType()) || "CONTROLLER".equals(node.layer())) {
            return "API";
        }
        if ("SERVICE".equals(node.layer())) {
            return "SERVICE";
        }
        if ("REPOSITORY".equals(node.layer()) || "ENTITY".equals(node.layer()) || "DB_ENTITY".equals(node.nodeType())) {
            return "DATA";
        }
        return null;
    }
}
