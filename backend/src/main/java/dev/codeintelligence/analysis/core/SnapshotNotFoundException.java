package dev.codeintelligence.analysis.core;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public class SnapshotNotFoundException extends ErrorResponseException {

    public SnapshotNotFoundException() {
        super(
                HttpStatus.NOT_FOUND,
                ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, "Snapshot not found."),
                null);
    }
}
