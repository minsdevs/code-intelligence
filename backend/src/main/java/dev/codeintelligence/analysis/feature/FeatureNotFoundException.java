package dev.codeintelligence.analysis.feature;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public class FeatureNotFoundException extends ErrorResponseException {

    public FeatureNotFoundException() {
        super(HttpStatus.NOT_FOUND, ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, "Feature not found."), null);
    }
}
