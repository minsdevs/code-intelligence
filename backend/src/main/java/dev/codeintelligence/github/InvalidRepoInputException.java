package dev.codeintelligence.github;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

/** Details name the offending field only; user input is never echoed back. */
public class InvalidRepoInputException extends ErrorResponseException {

    public InvalidRepoInputException(String detail) {
        super(HttpStatus.BAD_REQUEST, ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, detail), null);
    }
}
