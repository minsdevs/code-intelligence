package dev.codeintelligence.auth;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ResponseStatus;

@ResponseStatus(HttpStatus.NOT_FOUND)
public class GithubOAuthAttemptNotFoundException extends RuntimeException {

    public GithubOAuthAttemptNotFoundException() {
        super("GitHub login attempt was not found or does not belong to this workspace.");
    }
}
