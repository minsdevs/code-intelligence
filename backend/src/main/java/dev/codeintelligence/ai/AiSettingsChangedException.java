package dev.codeintelligence.ai;

import org.springframework.http.HttpStatus;
import org.springframework.web.ErrorResponseException;

public class AiSettingsChangedException extends ErrorResponseException {
    public AiSettingsChangedException() {
        super(HttpStatus.CONFLICT);
        getBody().setTitle("AI settings changed");
        getBody()
                .setDetail(
                        "AI settings changed before this request could continue. Refresh the settings and try again.");
        getBody().setProperty("code", "AI_SETTINGS_CHANGED");
    }
}
