package dev.codeintelligence.github;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

/** An actual upstream 401 requires reauthentication; permissions/rate limits are different errors. */
public class InvalidGithubTokenException extends ErrorResponseException
        implements dev.codeintelligence.common.RecoveryActionFailure {

    public InvalidGithubTokenException() {
        super(
                HttpStatus.UNAUTHORIZED,
                ProblemDetail.forStatusAndDetail(
                        HttpStatus.UNAUTHORIZED, "GitHub rejected the provided token. Sign in again."),
                null);
        getBody().setProperty("code", "GITHUB_REAUTHENTICATION_REQUIRED");
        getBody().setProperty("reason", "TOKEN_REJECTED");
    }

    @Override
    public String failureCode() {
        return "GITHUB_REAUTHENTICATION_REQUIRED";
    }
}
