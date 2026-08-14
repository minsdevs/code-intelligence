package dev.codeintelligence.search;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public class InvalidSearchQueryException extends ErrorResponseException {

    public InvalidSearchQueryException() {
        super(
                HttpStatus.BAD_REQUEST,
                ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "Search query is required."),
                null);
    }
}
