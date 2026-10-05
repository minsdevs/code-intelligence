package dev.codeintelligence.auth;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import org.springframework.stereotype.Component;

/** Per-account publication fence shared by device login, PAT, refresh and disconnect. */
@Component
public final class GithubConnectionCoordinator {
    private final ConcurrentMap<Long, Connection> connections = new ConcurrentHashMap<>();

    public Connection connection(long userId) {
        if (userId <= 0) throw new IllegalArgumentException("An authenticated account is required");
        return connections.computeIfAbsent(userId, ignored -> new Connection());
    }

    public static final class Connection {
        // Auth operations change this only while holding this monitor.
        volatile long value;
    }
}
