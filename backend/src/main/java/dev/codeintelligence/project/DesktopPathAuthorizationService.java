package dev.codeintelligence.project;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Service;

/** Per-process grants created only after the native folder picker returns a canonical directory. */
@Service
public class DesktopPathAuthorizationService {

    private final Set<Path> authorizedRoots = ConcurrentHashMap.newKeySet();

    public Path authorize(Path selected) {
        Path normalized = selected.toAbsolutePath().normalize();
        if (!Files.isDirectory(normalized) || !Files.isReadable(normalized)) {
            throw new LocalImportException("Selected path is not a readable directory.", null);
        }
        try {
            Path real = normalized.toRealPath();
            authorizedRoots.add(real);
            return real;
        } catch (IOException e) {
            throw new LocalImportException("Selected path could not be resolved.", e);
        }
    }

    public boolean isAuthorized(Path realPath) {
        return authorizedRoots.stream().anyMatch(root -> realPath.equals(root) || realPath.startsWith(root));
    }
}
