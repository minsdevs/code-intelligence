package dev.codeintelligence.job;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

/** Also covers jobs owned by another user (owner scoping never reveals existence). */
public class JobNotFoundException extends ErrorResponseException {

    public JobNotFoundException() {
        super(HttpStatus.NOT_FOUND, ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, "Job not found."), null);
    }
}
