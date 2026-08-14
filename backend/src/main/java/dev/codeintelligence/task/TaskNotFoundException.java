package dev.codeintelligence.task;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public class TaskNotFoundException extends ErrorResponseException {

    public TaskNotFoundException() {
        super(HttpStatus.NOT_FOUND, ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, "Task not found."), null);
    }
}
