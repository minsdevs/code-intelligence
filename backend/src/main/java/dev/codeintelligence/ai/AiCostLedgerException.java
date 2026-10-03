package dev.codeintelligence.ai;

/** Internal ledger failure. Contains a stable code, never request content or credentials. */
public final class AiCostLedgerException extends RuntimeException {
    private final String code;

    public AiCostLedgerException(String code) {
        super(code);
        this.code = code;
    }

    public String code() {
        return code;
    }
}
