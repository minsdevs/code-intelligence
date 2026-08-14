package dev.codeintelligence.analysis.core;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public class FileTooLargeException extends ErrorResponseException {

    public FileTooLargeException() {
        super(
                HttpStatus.CONTENT_TOO_LARGE,
                ProblemDetail.forStatusAndDetail(HttpStatus.CONTENT_TOO_LARGE, "File exceeds the size limit."),
                null);
    }
}
