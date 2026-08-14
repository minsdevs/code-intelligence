package dev.codeintelligence.analysis.area;

import dev.codeintelligence.common.security.AuthenticatedUser;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/projects")
public class AreaController {

    private final AreaService areaService;

    public AreaController(AreaService areaService) {
        this.areaService = areaService;
    }

    @GetMapping("/{projectId}/areas")
    public List<AreaService.AreaView> areas(
            @PathVariable long projectId,
            @RequestParam(required = false) Long snapshotId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return areaService.listAreas(projectId, user.userId(), snapshotId);
    }

    @PutMapping("/{projectId}/area-selections")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void updateSelections(
            @PathVariable long projectId,
            @RequestBody AreaService.AreaSelectionsRequest request,
            @AuthenticationPrincipal AuthenticatedUser user) {
        areaService.updateSelections(projectId, user.userId(), request);
    }
}
