package dev.codeintelligence.ai;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/** Stable user-facing failures; ledger internals and payload metadata are never echoed. */
@RestControllerAdvice(assignableTypes = {AiBudgetController.class, AssistantController.class})
public final class AiCostApiErrors {
    @ExceptionHandler(AiCostLedgerException.class)
    ProblemDetail costFailure(AiCostLedgerException error) {
        String code;
        HttpStatus status;
        String detail;
        switch (error.code()) {
            case "BUDGET_EXCEEDED" -> {
                code = "AI_COST_BUDGET_EXCEEDED";
                status = HttpStatus.TOO_MANY_REQUESTS;
                detail = "The request exceeds the daily or monthly AI budget, including pending usage.";
            }
            case "CONCURRENCY_LIMIT" -> {
                code = "AI_COST_BUSY";
                status = HttpStatus.CONFLICT;
                detail = "Two AI requests are already pending. Review their state before preparing another request.";
            }
            case "POLICY_CHANGED", "BUDGET_DAY_CHANGED", "COST_CONTRACT_EXPIRED", "DUPLICATE_REQUEST" -> {
                code = "AI_COST_PLAN_CHANGED";
                status = HttpStatus.CONFLICT;
                detail = "This approval is no longer valid. Review a new request plan before sending.";
            }
            default -> {
                code = "AI_COST_RECONCILIATION_REQUIRED";
                status = HttpStatus.SERVICE_UNAVAILABLE;
                detail =
                        "AI costs require reconciliation. Pending costs remain reserved and no automatic retry is performed.";
            }
        }
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(status, detail);
        problem.setTitle("AI request unavailable");
        problem.setProperty("code", code);
        return problem;
    }
}
