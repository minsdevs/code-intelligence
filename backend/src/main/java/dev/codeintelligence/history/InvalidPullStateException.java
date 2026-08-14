package dev.codeintelligence.history;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public class InvalidPullStateException extends ErrorResponseException {

    public InvalidPullStateException() {
        super(
                HttpStatus.BAD_REQUEST,
                ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "Invalid pull state."),
                null);
    }
}
