package dev.codeintelligence.ai;

import org.springframework.http.HttpStatus;
import org.springframework.web.ErrorResponseException;

public class AiSafetyUnavailableException extends ErrorResponseException {
    public AiSafetyUnavailableException() {
        super(HttpStatus.SERVICE_UNAVAILABLE);
        getBody().setTitle("AI connection unavailable");
        getBody().setDetail("AI connections are unavailable in this desktop build. Local analysis remains available.");
        getBody().setProperty("code", "DESKTOP_AI_SAFETY_UNAVAILABLE");
    }
}
