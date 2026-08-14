package dev.codeintelligence.project;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

/** Also covers projects owned by another user (owner scoping never reveals existence). */
public class ProjectNotFoundException extends ErrorResponseException {

    public ProjectNotFoundException() {
        super(HttpStatus.NOT_FOUND, ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, "Project not found."), null);
    }
}
