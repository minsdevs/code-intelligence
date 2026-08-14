package dev.codeintelligence.ai;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public class AiProviderException extends ErrorResponseException {

    public AiProviderException(Throwable cause) {
        super(
                HttpStatus.BAD_GATEWAY,
                ProblemDetail.forStatusAndDetail(HttpStatus.BAD_GATEWAY, "AI provider request failed."),
                cause);
    }
}
