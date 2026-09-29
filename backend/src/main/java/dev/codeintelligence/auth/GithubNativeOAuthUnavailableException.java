package dev.codeintelligence.auth;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ResponseStatus;

@ResponseStatus(HttpStatus.SERVICE_UNAVAILABLE)
public class GithubNativeOAuthUnavailableException extends RuntimeException {

    public GithubNativeOAuthUnavailableException() {
        super("GitHub native OAuth is not configured. Set GITHUB_NATIVE_CLIENT_ID.");
    }
}
