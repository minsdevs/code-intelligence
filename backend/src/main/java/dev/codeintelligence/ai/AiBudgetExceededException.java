package dev.codeintelligence.ai;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public class AiBudgetExceededException extends ErrorResponseException {

    public AiBudgetExceededException() {
        super(
                HttpStatus.TOO_MANY_REQUESTS,
                ProblemDetail.forStatusAndDetail(HttpStatus.TOO_MANY_REQUESTS, "Daily AI token budget exceeded."),
                null);
    }
}
