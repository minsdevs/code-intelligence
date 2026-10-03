package dev.codeintelligence.analysis.core;

import dev.codeintelligence.common.security.AuthenticatedUser;
import java.util.List;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/projects")
public class FileController {

    private final FileService fileService;

    public FileController(FileService fileService) {
        this.fileService = fileService;
    }

    @GetMapping("/{projectId}/files")
    public List<FileService.FileListItem> files(
            @PathVariable long projectId,
            @RequestParam(required = false) Long snapshotId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return fileService.listFiles(projectId, user.userId(), snapshotId);
    }

    @GetMapping("/{projectId}/file-content")
    public FileService.FileContent fileContent(
            @PathVariable long projectId,
            @RequestParam String path,
            @RequestParam(required = false) Long snapshotId,
            @RequestParam(required = false) Long evidenceId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return fileService.fileContent(projectId, user.userId(), path, snapshotId, evidenceId);
    }

    @GetMapping("/{projectId}/stats")
    public FileService.ProjectStats stats(
            @PathVariable long projectId,
            @RequestParam(required = false) Long snapshotId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return fileService.stats(projectId, user.userId(), snapshotId);
    }
}
