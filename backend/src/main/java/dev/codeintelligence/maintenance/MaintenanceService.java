package dev.codeintelligence.maintenance;

import dev.codeintelligence.auth.DesktopAuthProperties;
import dev.codeintelligence.common.security.AuthenticatedUser;
import dev.codeintelligence.common.security.CredentialKind;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/** The path token is a main-process capability; the renderer launch token alone is insufficient. */
@Service
public class MaintenanceService {
    private final MaintenanceGate gate;
    private final JdbcClient jdbc;
    private final DesktopAuthProperties desktop;
    private final byte[] pathToken;

    public MaintenanceService(
            MaintenanceGate gate,
            JdbcClient jdbc,
            DesktopAuthProperties desktop,
            @Value("${app.desktop.path-token:}") String pathToken) {
        this.gate = gate;
        this.jdbc = jdbc;
        this.desktop = desktop;
        this.pathToken = (pathToken == null || pathToken.isBlank() ? "" : pathToken).getBytes(StandardCharsets.UTF_8);
    }

    public MaintenanceGate.View control(
            UUID id, Operation operation, AuthenticatedUser user, String providedPathToken) {
        authorize(user, providedPathToken);
        // Set BEGIN synchronously, before the SQL observation. SQL failure intentionally leaves
        // the barrier active. A ticket prevents an old observation ending a newer transaction.
        MaintenanceGate.Ticket ticket = operation == Operation.BEGIN ? gate.begin(id) : gate.current(id);
        long databaseJobs = jdbc.sql("""
                select count(*) from analysis_jobs
                where status in ('QUEUED', 'RUNNING', 'CANCELLING')
                """).query(Long.class).single();
        return operation == Operation.END ? gate.end(ticket, databaseJobs) : gate.snapshot(ticket, databaseJobs);
    }

    private void authorize(AuthenticatedUser user, String providedPathToken) {
        if (!desktop.configured()
                || pathToken.length == 0
                || user == null
                || user.credentialKind() != CredentialKind.LOCAL
                || providedPathToken == null
                || !MessageDigest.isEqual(pathToken, providedPathToken.getBytes(StandardCharsets.UTF_8))) {
            throw forbidden();
        }
        boolean owner = jdbc.sql("""
                        select exists (
                            select 1 from users
                            where id = :userId and local_key = :localIdentity
                              and identity_type in ('LOCAL', 'LOCAL_LINKED')
                        )
                        """)
                .param("userId", user.userId())
                .param("localIdentity", desktop.localIdentity())
                .query(Boolean.class)
                .single();
        if (!owner) throw forbidden();
    }

    private static ResponseStatusException forbidden() {
        return new ResponseStatusException(HttpStatus.FORBIDDEN, "DESKTOP_MAINTENANCE_FORBIDDEN");
    }

    public enum Operation {
        BEGIN,
        STATUS,
        END
    }
}
