package dev.codeintelligence.common;

/** Main-owned local bridge capability, supplied only by the inherited private bootstrap. */
public record SourceStoreProperties(String socketPath, String brokerToken) {

    public SourceStoreProperties {
        boolean noSocket = socketPath == null || socketPath.isBlank();
        boolean noToken = brokerToken == null || brokerToken.isBlank();
        if (noSocket && noToken) {
            socketPath = "";
            brokerToken = "";
        } else {
            if (noSocket || noToken || !brokerToken.matches("[0-9a-f]{64}")) throw invalid();
            try {
                DesktopPrivateBootstrap.validatePath(socketPath);
            } catch (RuntimeException ex) {
                throw invalid();
            }
        }
    }

    public boolean enabled() {
        return !socketPath.isEmpty();
    }

    @Override
    public String toString() {
        return "SourceStoreProperties[enabled=" + enabled() + "]";
    }

    private static IllegalStateException invalid() {
        return new IllegalStateException("app.source-store requires a valid local socket and broker capability");
    }
}
