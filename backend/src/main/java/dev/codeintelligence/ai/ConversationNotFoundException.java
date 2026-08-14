package dev.codeintelligence.ai;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public class ConversationNotFoundException extends ErrorResponseException {

    public ConversationNotFoundException() {
        super(
                HttpStatus.NOT_FOUND,
                ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, "Conversation not found."),
                null);
    }
}
