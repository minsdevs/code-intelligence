package dev.codeintelligence.auth;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

/** A fixed public error; provider responses and credential material are never retained as causes. */
public final class GithubReauthenticationRequiredException extends ErrorResponseException
        implements dev.codeintelligence.common.RecoveryActionFailure {

    public GithubReauthenticationRequiredException(String reason) {
        super(HttpStatus.UNAUTHORIZED, problem(reason), null);
    }

    @Override
    public String failureCode() {
        return "GITHUB_REAUTHENTICATION_REQUIRED";
    }

    private static ProblemDetail problem(String reason) {
        String safeReason =
                switch (reason == null ? "" : reason) {
                    case "TOKEN_EXPIRED",
                            "EXPIRY_UNKNOWN",
                            "TOKEN_REJECTED",
                            "REFRESH_IN_PROGRESS",
                            "REFRESH_UNCERTAIN",
                            "CREDENTIAL_INVALID",
                            "CONNECTION_CHANGED",
                            "CLIENT_CHANGED",
                            "REFRESH_EXPIRED" -> reason;
                    default -> "CREDENTIAL_INVALID";
                };
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(
                HttpStatus.UNAUTHORIZED, "GitHub authentication must be renewed before this request can continue.");
        problem.setTitle("GitHub reauthentication required");
        problem.setProperty("code", "GITHUB_REAUTHENTICATION_REQUIRED");
        problem.setProperty("reason", safeReason);
        return problem;
    }
}
