package dev.codeintelligence.auth;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ResponseStatus;

@ResponseStatus(HttpStatus.CONFLICT)
public class GithubAccountConflictException extends RuntimeException {

    public GithubAccountConflictException() {
        super("This GitHub account is already connected to another local workspace.");
    }
}
