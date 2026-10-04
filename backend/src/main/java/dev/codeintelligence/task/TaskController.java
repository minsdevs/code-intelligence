package dev.codeintelligence.task;

import dev.codeintelligence.common.security.AuthenticatedUser;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/projects/{projectId}/tasks")
public class TaskController {

    private final TaskService taskService;

    public TaskController(TaskService taskService) {
        this.taskService = taskService;
    }

    @GetMapping
    public List<TaskService.TaskView> list(
            @PathVariable long projectId,
            @RequestParam(defaultValue = "false") boolean includeDrafts,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return taskService.list(projectId, user.userId(), includeDrafts);
    }

    @GetMapping("/{taskId}")
    public TaskService.TaskView get(
            @PathVariable long projectId, @PathVariable long taskId, @AuthenticationPrincipal AuthenticatedUser user) {
        return taskService.get(projectId, user.userId(), taskId);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public TaskService.TaskView create(
            @PathVariable long projectId,
            @RequestBody TaskService.UpsertTask body,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return taskService.create(projectId, user.userId(), body);
    }

    @PutMapping("/{taskId}")
    public TaskService.TaskView update(
            @PathVariable long projectId,
            @PathVariable long taskId,
            @RequestBody TaskService.UpsertTask body,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return taskService.update(projectId, user.userId(), taskId, body);
    }

    @PostMapping("/{taskId}/approve")
    public TaskService.TaskView approve(
            @PathVariable long projectId, @PathVariable long taskId, @AuthenticationPrincipal AuthenticatedUser user) {
        return taskService.approve(projectId, user.userId(), taskId);
    }

    @PatchMapping("/{taskId}/goals/{goalId}")
    public TaskService.GoalView patchGoal(
            @PathVariable long projectId,
            @PathVariable long taskId,
            @PathVariable long goalId,
            @RequestBody TaskService.GoalPatch body,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return taskService.patchGoal(projectId, user.userId(), taskId, goalId, body);
    }

    @DeleteMapping("/{taskId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(
            @PathVariable long projectId, @PathVariable long taskId, @AuthenticationPrincipal AuthenticatedUser user) {
        taskService.delete(projectId, user.userId(), taskId);
    }
}
