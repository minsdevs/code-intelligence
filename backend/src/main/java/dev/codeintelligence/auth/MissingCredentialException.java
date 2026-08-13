package dev.codeintelligence.auth;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public class MissingCredentialException extends ErrorResponseException {

    public MissingCredentialException() {
        super(
                HttpStatus.UNAUTHORIZED,
                ProblemDetail.forStatusAndDetail(
                        HttpStatus.UNAUTHORIZED, "No GitHub credential registered. Log in again."),
                null);
    }
}
