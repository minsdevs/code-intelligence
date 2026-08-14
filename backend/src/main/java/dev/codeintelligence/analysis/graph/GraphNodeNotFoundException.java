package dev.codeintelligence.analysis.graph;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public class GraphNodeNotFoundException extends ErrorResponseException {

    public GraphNodeNotFoundException() {
        super(
                HttpStatus.NOT_FOUND,
                ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, "Graph node not found."),
                null);
    }
}
