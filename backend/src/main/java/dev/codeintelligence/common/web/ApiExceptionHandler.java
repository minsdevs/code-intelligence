package dev.codeintelligence.common.web;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.client.RestClientException;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

/**
 * Uniform ProblemDetail responses (§4 API 규약). ErrorResponseException subclasses are rendered
 * by the base class; upstream GitHub failures collapse to a fixed 502 detail so no internals leak.
 */
@RestControllerAdvice
public class ApiExceptionHandler extends ResponseEntityExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

    @ExceptionHandler(RestClientException.class)
    ProblemDetail handleGithubApiFailure(RestClientException e) {
        log.warn("GitHub API request failed: {}", e.getMessage());
        return ProblemDetail.forStatusAndDetail(HttpStatus.BAD_GATEWAY, "GitHub API request failed.");
    }
}
