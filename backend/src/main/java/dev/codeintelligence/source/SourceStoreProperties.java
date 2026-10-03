package dev.codeintelligence.source;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/** Main-owned local bridge capability. This configuration never contains a source encryption key. */
@ConfigurationProperties("app.source-store")
public record SourceStoreProperties(
        @DefaultValue("") String socketPath,
        @DefaultValue("") String brokerToken) {

    public SourceStoreProperties {
        boolean noSocket = socketPath == null || socketPath.isBlank();
        boolean noToken = brokerToken == null || brokerToken.isBlank();
        if (noSocket && noToken) {
            socketPath = "";
            brokerToken = "";
        } else {
            if (noSocket || noToken || !brokerToken.matches("[0-9a-f]{64}")) throw invalid();
            try {
                Path path = Path.of(socketPath);
                if (!path.isAbsolute()
                        || !path.normalize().toString().equals(socketPath)
                        || socketPath.getBytes(StandardCharsets.UTF_8).length > 100) throw invalid();
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
