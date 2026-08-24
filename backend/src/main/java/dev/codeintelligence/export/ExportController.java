package dev.codeintelligence.export;

import dev.codeintelligence.common.security.AuthenticatedUser;
import java.nio.charset.StandardCharsets;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.json.JsonMapper;

/**
 * GET /api/projects/{projectId}/export — generates a downloadable analysis summary.
 * Supports markdown (default) and JSON formats.
 */
@RestController
@RequestMapping("/api/projects/{projectId}/export")
public class ExportController {

    private final ExportService exportService;
    private final JsonMapper json;

    public ExportController(ExportService exportService, JsonMapper json) {
        this.exportService = exportService;
        this.json = json;
    }

    @GetMapping
    public ResponseEntity<byte[]> export(
            @PathVariable long projectId,
            @RequestParam(defaultValue = "markdown") String format,
            @AuthenticationPrincipal AuthenticatedUser user) {
        ExportService.ExportData data = exportService.buildExportData(projectId, user.userId());
        String safeName =
                data.projectName().replaceAll("[^a-zA-Z0-9가-힣_\\- ]", "").strip();
        if (safeName.isBlank()) {
            safeName = "project";
        }

        if ("json".equalsIgnoreCase(format)) {
            String body = json.writeValueAsString(exportService.toJson(data));
            return ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + safeName + "-summary.json\"")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body.getBytes(StandardCharsets.UTF_8));
        }

        String body = exportService.toMarkdown(data);
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + safeName + "-summary.md\"")
                .contentType(MediaType.parseMediaType("text/markdown; charset=UTF-8"))
                .body(body.getBytes(StandardCharsets.UTF_8));
    }
}
