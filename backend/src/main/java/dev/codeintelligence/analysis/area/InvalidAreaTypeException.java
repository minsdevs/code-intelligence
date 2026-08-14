package dev.codeintelligence.analysis.area;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public class InvalidAreaTypeException extends ErrorResponseException {

    public InvalidAreaTypeException() {
        super(
                HttpStatus.BAD_REQUEST,
                ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "Invalid area type."),
                null);
    }
}
