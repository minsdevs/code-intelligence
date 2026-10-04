package dev.codeintelligence.analysis.graph;

import dev.codeintelligence.common.security.AuthenticatedUser;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/projects")
public class GraphController {

    private final GraphService graphService;

    public GraphController(GraphService graphService) {
        this.graphService = graphService;
    }

    @GetMapping("/{projectId}/graph/overview")
    public GraphService.GraphOverview overview(
            @PathVariable long projectId,
            @RequestParam(required = false) Long snapshotId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return graphService.overview(projectId, user.userId(), snapshotId);
    }

    @GetMapping("/{projectId}/graph/nodes")
    public GraphService.GraphNodePage nodes(
            @PathVariable long projectId,
            @RequestParam(required = false) String type,
            @RequestParam(required = false) String area,
            @RequestParam(required = false) String q,
            @RequestParam(required = false) String path,
            @RequestParam(required = false) String sort,
            @RequestParam(required = false) String category,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size,
            @RequestParam(required = false) Long snapshotId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return graphService.listNodes(
                projectId, user.userId(), snapshotId, type, area, q, path, page, size, sort, category);
    }

    @GetMapping("/{projectId}/graph/nodes/{nodeId}")
    public GraphService.GraphNodeDetail node(
            @PathVariable long projectId,
            @PathVariable long nodeId,
            @RequestParam(required = false) Long snapshotId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return graphService.nodeDetail(projectId, user.userId(), nodeId, snapshotId);
    }

    @GetMapping("/{projectId}/graph/nodes/{nodeId}/relations")
    public GraphService.GraphRelationsResponse relations(
            @PathVariable long projectId,
            @PathVariable long nodeId,
            @RequestParam(required = false) String direction,
            @RequestParam(required = false) String edgeType,
            @RequestParam(required = false) Integer depth,
            @RequestParam(required = false) Long snapshotId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return graphService.relations(projectId, user.userId(), nodeId, snapshotId, direction, edgeType, depth);
    }
}
