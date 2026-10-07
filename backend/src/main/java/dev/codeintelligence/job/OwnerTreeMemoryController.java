package dev.codeintelligence.job;

import dev.codeintelligence.common.security.AuthenticatedUser;
import dev.codeintelligence.common.security.CredentialKind;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Desktop main posts its owner-tree RSS here for the 05 §4 watchdog. Like folder grants, only the
 * main process may call it: it holds the separate main capability that the renderer never sees.
 * The answer tells main whether a run is watched, so it samples every 2 s only while one is.
 */
@RestController
@RequestMapping(OwnerTreeMemoryController.PATH)
public class OwnerTreeMemoryController {
    public static final String PATH = "/api/desktop/owner-memory";

    private final ReportedOwnerTreeMemory memory;
    private final AnalysisMemoryWatchdog watchdog;
    private final String pathToken;

    public OwnerTreeMemoryController(
            ReportedOwnerTreeMemory memory,
            AnalysisMemoryWatchdog watchdog,
            @Value("${app.desktop.path-token:}") String pathToken) {
        this.memory = memory;
        this.watchdog = watchdog;
        this.pathToken = pathToken;
    }

    @PostMapping
    public Demand report(
            @RequestBody Report report,
            @AuthenticationPrincipal AuthenticatedUser user,
            @RequestHeader(value = "X-Code-Intelligence-Path-Token", required = false) String providedToken) {
        if (user.credentialKind() != CredentialKind.LOCAL
                || pathToken.isBlank()
                || providedToken == null
                || !MessageDigest.isEqual(
                        pathToken.getBytes(StandardCharsets.UTF_8), providedToken.getBytes(StandardCharsets.UTF_8))) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Only the desktop main process reports memory.");
        }
        if (report.ownerTreeBytes() == null || report.ownerTreeBytes() < 0)
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "A non-negative byte count is required.");
        memory.report(report.ownerTreeBytes());
        return new Demand(watchdog.watching());
    }

    public record Report(Long ownerTreeBytes) {}

    public record Demand(boolean watching) {}
}
