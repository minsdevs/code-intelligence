package dev.codeintelligence.analysis.core;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public class InvalidFilePathException extends ErrorResponseException {

    public InvalidFilePathException() {
        super(
                HttpStatus.BAD_REQUEST,
                ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "Invalid file path."),
                null);
    }
}
