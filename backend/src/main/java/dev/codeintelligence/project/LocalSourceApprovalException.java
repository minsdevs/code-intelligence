package dev.codeintelligence.project;

import dev.codeintelligence.job.JobInputFailure;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

/** Safe fixed messages only: no source paths, preview tokens or source bodies. */
public class LocalSourceApprovalException extends ErrorResponseException implements JobInputFailure {
    public static final String RECOVERY_CODE = "LOCAL_PREVIEW_REQUIRED";
    private static final Set<String> CODES = Set.of(
            "LOCAL_PREVIEW_INVALID",
            "LOCAL_PREVIEW_EXPIRED",
            "LOCAL_PREVIEW_CONSUMED",
            "LOCAL_PREVIEW_BASE_CHANGED",
            "LOCAL_SOURCE_CHANGED",
            "LOCAL_PREVIEW_BUSY");

    public LocalSourceApprovalException(String code, String message) {
        super(HttpStatus.CONFLICT, problem(code, message), null);
    }

    private static ProblemDetail problem(String code, String message) {
        if (!CODES.contains(code)) throw new IllegalArgumentException("Unknown local preview error code");
        ProblemDetail body = ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, message);
        body.setProperty("code", code);
        return body;
    }

    public static LocalSourceApprovalException sourceChanged() {
        return new LocalSourceApprovalException(
                "LOCAL_SOURCE_CHANGED", "The approved local source changed. Create and confirm a new preview.");
    }

    public static LocalSourceApprovalException invalid() {
        return new LocalSourceApprovalException(
                "LOCAL_PREVIEW_INVALID", "This local preview cannot authorize the operation. Create a new preview.");
    }

    @Override
    public String failureCode() {
        return RECOVERY_CODE;
    }
}
