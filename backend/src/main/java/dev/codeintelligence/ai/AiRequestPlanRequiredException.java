package dev.codeintelligence.ai;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

/** Never echoes a capability, source payload or mismatch details. */
public final class AiRequestPlanRequiredException extends ErrorResponseException {
    public AiRequestPlanRequiredException() {
        super(HttpStatus.CONFLICT, problem(), null);
    }

    private static ProblemDetail problem() {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(
                HttpStatus.CONFLICT,
                "A fresh AI request preview and confirmation are required. The previous request is not retried.");
        problem.setProperty("code", "AI_REQUEST_PLAN_REQUIRED");
        return problem;
    }
}
