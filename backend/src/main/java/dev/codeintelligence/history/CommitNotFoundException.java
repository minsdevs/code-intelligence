package dev.codeintelligence.history;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public class CommitNotFoundException extends ErrorResponseException {

    public CommitNotFoundException() {
        super(HttpStatus.NOT_FOUND, ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, "Commit not found."), null);
    }
}
