package dev.codeintelligence.ai;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public class AiNotConfiguredException extends ErrorResponseException {

    public AiNotConfiguredException() {
        super(
                HttpStatus.SERVICE_UNAVAILABLE,
                ProblemDetail.forStatusAndDetail(HttpStatus.SERVICE_UNAVAILABLE, "AI provider is not configured."),
                null);
    }
}
