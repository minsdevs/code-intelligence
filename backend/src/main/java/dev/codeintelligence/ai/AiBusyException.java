package dev.codeintelligence.ai;

import org.springframework.http.HttpStatus;
import org.springframework.web.ErrorResponseException;

public class AiBusyException extends ErrorResponseException {
    public AiBusyException() {
        super(HttpStatus.TOO_MANY_REQUESTS);
        getBody().setTitle("AI requests in progress");
        getBody().setDetail("Two AI requests are already in progress. Wait for one to finish before trying again.");
        getBody().setProperty("code", "AI_BUSY");
    }
}
