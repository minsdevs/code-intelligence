package dev.codeintelligence.analysis.core;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public final class SnapshotSourceException extends ErrorResponseException {
    private SnapshotSourceException(HttpStatus status, String code, String detail) {
        super(status, problem(status, code, detail), null);
    }

    private static ProblemDetail problem(HttpStatus status, String code, String detail) {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(status, detail);
        problem.setProperty("code", code);
        problem.setProperty("sourceState", code);
        return problem;
    }

    public static SnapshotSourceException unavailable() {
        return new SnapshotSourceException(
                HttpStatus.GONE,
                "SOURCE_UNAVAILABLE",
                "Source bytes for this snapshot are unavailable. Current files have not been substituted.");
    }

    public static SnapshotSourceException unknown() {
        return new SnapshotSourceException(
                HttpStatus.GONE,
                "SOURCE_CONTEXT_UNKNOWN",
                "The source context of this legacy evidence cannot be verified. Open current source separately.");
    }

    public static SnapshotSourceException stale() {
        return new SnapshotSourceException(
                HttpStatus.CONFLICT,
                "EVIDENCE_STALE",
                "Source object integrity or snapshot evidence context does not match.");
    }

    public static SnapshotSourceException encoding() {
        return new SnapshotSourceException(
                HttpStatus.UNSUPPORTED_MEDIA_TYPE,
                "SOURCE_ENCODING_UNSUPPORTED",
                "Source is not valid UTF-8 and cannot be displayed without changing its bytes.");
    }
}
