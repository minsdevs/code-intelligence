package dev.codeintelligence.ai;

import java.util.List;
import java.util.Locale;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public enum AiIntent {
    EXPLAIN,
    WHY,
    ALTERNATIVE,
    ARCHITECTURE,
    PROJECT,
    FINDING;

    public static AiIntent from(String raw) {
        if (raw == null || raw.isBlank()) {
            return EXPLAIN;
        }
        try {
            return AiIntent.valueOf(raw.strip().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw new InvalidAiIntentException();
        }
    }

    public static final class InvalidAiIntentException extends ErrorResponseException {
        public InvalidAiIntentException() {
            super(
                    HttpStatus.BAD_REQUEST,
                    ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "Invalid AI intent."),
                    null);
        }
    }

    public static AiIntent infer(String question) {
        if (question == null) {
            return EXPLAIN;
        }
        String q = question.toLowerCase(Locale.ROOT);
        if (q.contains("대안") || q.contains("alternative")) {
            return ALTERNATIVE;
        }
        if (q.contains("왜") || q.contains("why")) {
            return WHY;
        }
        if (q.contains("구조") || q.contains("architecture")) {
            return ARCHITECTURE;
        }
        if (q.contains("finding") || q.contains("문제")) {
            return FINDING;
        }
        return EXPLAIN;
    }

    public static List<AiIntent> all() {
        return List.of(values());
    }
}
