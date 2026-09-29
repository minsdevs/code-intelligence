package dev.codeintelligence.github;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

/** GitHub authenticated the user but denied repository access, commonly due to org SSO policy. */
public class GithubRepositoryAccessException extends ErrorResponseException {

    public GithubRepositoryAccessException() {
        super(
                HttpStatus.FORBIDDEN,
                ProblemDetail.forStatusAndDetail(
                        HttpStatus.FORBIDDEN,
                        "GitHub denied repository access. Authorize this app or token for the organization (including SSO), then retry."),
                null);
    }
}
