package dev.codeintelligence.github;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

/** GitHub rejected the token (401/403). Rendered as a 400 ProblemDetail; never echoes the token. */
public class InvalidGithubTokenException extends ErrorResponseException {

    public InvalidGithubTokenException() {
        super(
                HttpStatus.BAD_REQUEST,
                ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "GitHub rejected the provided token."),
                null);
    }
}
