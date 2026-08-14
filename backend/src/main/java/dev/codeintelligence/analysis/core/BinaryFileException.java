package dev.codeintelligence.analysis.core;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public class BinaryFileException extends ErrorResponseException {

    public BinaryFileException() {
        super(
                HttpStatus.UNSUPPORTED_MEDIA_TYPE,
                ProblemDetail.forStatusAndDetail(
                        HttpStatus.UNSUPPORTED_MEDIA_TYPE, "Binary files cannot be displayed."),
                null);
    }
}
