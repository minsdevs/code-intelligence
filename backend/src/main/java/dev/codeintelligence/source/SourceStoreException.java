package dev.codeintelligence.source;

/** Fixed safe failures: broker messages, source bytes, capabilities and paths are never attached. */
public final class SourceStoreException extends RuntimeException {
    private final String code;

    private SourceStoreException(String code) {
        super(code, null, false, true);
        this.code = code;
    }

    public String code() {
        return code;
    }

    static SourceStoreException disabled() {
        return new SourceStoreException("SOURCE_STORE_DISABLED");
    }

    static SourceStoreException invalidRequest() {
        return new SourceStoreException("SOURCE_STORE_INVALID_REQUEST");
    }

    static SourceStoreException unavailable() {
        return new SourceStoreException("SOURCE_STORE_UNAVAILABLE");
    }

    static SourceStoreException integrity() {
        return new SourceStoreException("SOURCE_STORE_INTEGRITY");
    }
}
