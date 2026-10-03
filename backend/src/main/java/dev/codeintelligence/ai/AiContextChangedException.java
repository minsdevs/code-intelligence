package dev.codeintelligence.ai;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

/** No context contents or client-supplied IDs are included in the response. */
public final class AiContextChangedException extends ErrorResponseException {
    public AiContextChangedException() {
        super(HttpStatus.CONFLICT, problem(), null);
    }

    private static ProblemDetail problem() {
        ProblemDetail body = ProblemDetail.forStatusAndDetail(
                HttpStatus.CONFLICT, "AI context changed. Create a new preview and confirm the excluded items.");
        body.setProperty("code", "AI_CONTEXT_CHANGED");
        return body;
    }
}
