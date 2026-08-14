package dev.codeintelligence.ai;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public class PlaygroundSessionNotFoundException extends ErrorResponseException {

    public PlaygroundSessionNotFoundException() {
        super(
                HttpStatus.NOT_FOUND,
                ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, "Playground session not found."),
                null);
    }
}
