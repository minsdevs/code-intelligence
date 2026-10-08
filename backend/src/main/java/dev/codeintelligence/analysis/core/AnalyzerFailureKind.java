package dev.codeintelligence.analysis.core;

import java.net.SocketTimeoutException;
import java.net.http.HttpTimeoutException;
import java.util.concurrent.TimeoutException;
import org.springframework.web.client.RestClientResponseException;

/** Classify typed transport failures, never response text or exception messages. */
public enum AnalyzerFailureKind {
    TIMEOUT,
    REJECTED,
    TRANSPORT_ERROR;

    public static AnalyzerFailureKind fromCause(Throwable cause) {
        for (Throwable current = cause; current != null; current = current.getCause()) {
            if (current instanceof HttpTimeoutException
                    || current instanceof SocketTimeoutException
                    || current instanceof TimeoutException) {
                return TIMEOUT;
            }
            if (current instanceof RestClientResponseException response
                    && response.getStatusCode().is4xxClientError()) {
                return REJECTED;
            }
        }
        // A closed connection alone cannot establish that the analyzer process crashed.
        return TRANSPORT_ERROR;
    }
}
