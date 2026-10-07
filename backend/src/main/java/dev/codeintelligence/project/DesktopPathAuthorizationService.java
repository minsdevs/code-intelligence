package dev.codeintelligence.project;

import dev.codeintelligence.common.SourceAccess;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

/**
 * Per-process folder authority. Main calls {@link #authorize} only after the native folder dialog
 * (or a native confirmation of a dropped folder). Each selection is a grant for exactly one canonical
 * root, pinned to the root's identity, expiring after {@link #GRANT_TTL} and spent by the one
 * confirmation that creates or relinks a project. Spent and restored roots serve only their
 * project's refresh and approved copy; a new selection always needs a new grant.
 */
@Service
public class DesktopPathAuthorizationService {

    static final Duration GRANT_TTL = Duration.ofMinutes(15);
    private static final int MAX_LIVE_GRANTS = 64;

    /** The selection receipt returned to main; the nonce is the one-time capability. */
    public record Grant(Path path, String nonce, Instant expiresAt) {}

    private record Pending(Path root, SourceAccess.Identity identity, Instant expiresAt) {}

    private final Map<String, Pending> grants = new ConcurrentHashMap<>();
    private final Set<Path> projectRoots = ConcurrentHashMap.newKeySet();
    private final SecureRandom random = new SecureRandom();
    private final Clock clock;

    @Autowired
    public DesktopPathAuthorizationService() {
        this(Clock.systemUTC());
    }

    DesktopPathAuthorizationService(Clock clock) {
        this.clock = clock;
    }

    public synchronized Grant authorize(Path selected) {
        Path real = canonicalDirectory(selected);
        Instant now = clock.instant();
        grants.values().removeIf(grant -> !now.isBefore(grant.expiresAt()));
        if (grants.size() >= MAX_LIVE_GRANTS)
            throw new LocalImportException("Too many folder selections are pending. Try again later.", null);
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        String nonce = HexFormat.of().formatHex(bytes);
        Instant expires = now.plus(GRANT_TTL);
        grants.put(nonce, new Pending(real, identity(real), expires));
        return new Grant(real, nonce, expires);
    }

    /** Re-registers a root main persisted for an existing project; it never authorizes a new selection. */
    public Path restore(Path selected) {
        Path real = canonicalDirectory(selected);
        projectRoots.add(real);
        return real;
    }

    /** A live, unspent grant for exactly this root whose identity is unchanged. Does not spend it. */
    public boolean isGranted(String nonce, Path realPath) {
        return live(nonce, realPath) != null;
    }

    /** Spends the grant once; the root then serves the confirmed project's refresh and copy. */
    public void consume(String nonce, Path realPath) {
        Pending pending = live(nonce, realPath);
        if (pending == null || !grants.remove(nonce, pending)) {
            throw new LocalImportException(
                    "The folder selection expired or was already used. Choose the folder again.", null);
        }
        projectRoots.add(pending.root());
    }

    public boolean isAuthorized(Path realPath) {
        if (projectRoots.contains(realPath)) return true;
        for (Map.Entry<String, Pending> grant : grants.entrySet())
            if (grant.getValue().root().equals(realPath) && live(grant.getKey(), realPath) != null) return true;
        return false;
    }

    private Pending live(String nonce, Path realPath) {
        if (nonce == null || realPath == null) return null;
        Pending pending = grants.get(nonce);
        if (pending == null || !pending.root().equals(realPath)) return null;
        if (!clock.instant().isBefore(pending.expiresAt())) {
            grants.remove(nonce, pending);
            return null;
        }
        try {
            // A folder swapped in at the same path after the dialog is a different root.
            return pending.identity().equals(identity(realPath)) ? pending : null;
        } catch (LocalImportException e) {
            return null;
        }
    }

    private static Path canonicalDirectory(Path selected) {
        Path normalized = selected.toAbsolutePath().normalize();
        if (!Files.isDirectory(normalized) || !Files.isReadable(normalized)) {
            throw new LocalImportException("Selected path is not a readable directory.", null);
        }
        try {
            return normalized.toRealPath();
        } catch (IOException e) {
            throw new LocalImportException("Selected path could not be resolved.", e);
        }
    }

    private static SourceAccess.Identity identity(Path real) {
        try (SourceAccess.Scope ignored = SourceAccess.open(real, "source")) {
            return SourceAccess.identity(real);
        } catch (IOException e) {
            throw new LocalImportException("Selected path could not be verified.", e);
        }
    }
}
