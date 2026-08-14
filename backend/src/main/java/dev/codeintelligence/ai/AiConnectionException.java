package dev.codeintelligence.ai;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public class AiConnectionException extends ErrorResponseException {

    public AiConnectionException(Throwable cause) {
        super(
                HttpStatus.BAD_REQUEST,
                ProblemDetail.forStatusAndDetail(
                        HttpStatus.BAD_REQUEST,
                        "The AI provider rejected the key or model. Verify both values and try again."),
                cause);
    }
}
