package dev.codeintelligence.job;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public class JobConflictException extends ErrorResponseException {

    public JobConflictException(String detail) {
        super(HttpStatus.CONFLICT, ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, detail), null);
    }

    public JobConflictException(String detail, String code) {
        this(detail);
        getBody().setProperty("code", code);
    }
}
