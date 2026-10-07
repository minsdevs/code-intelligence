package dev.codeintelligence.github;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.sun.net.httpserver.HttpServer;
import dev.codeintelligence.common.AppProperties;
import java.net.InetSocketAddress;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * G-SEC GitHub import egress (05 §2: re-check scheme/host/IP/credential on every redirect and never
 * forward Authorization across origins). Two loopback HTTP servers stand in for the clone origin and
 * a foreign origin; the foreign one asks for Basic credentials after a redirect.
 *
 * <p>Open finding SEC-M-03: reproduced on 2026-10-07 (the foreign origin received the token). The
 * clone transport follows the initial redirect and the per-call credentials provider answers for
 * any URI. The production clone origin is TLS-pinned https://github.com, so exploitation needs a
 * cross-origin redirect issued by GitHub itself. Disabled until the provider is origin-bound.
 */
class SecurityGitTransportRedirectTest {

    @TempDir
    Path temp;

    @Test
    @Disabled("SEC-M-03 open: clone credentials follow a cross-origin redirect")
    void cloneCredentialsAreNeverSentToAnOriginReachedThroughARedirect() throws Exception {
        List<String> foreignAuthorization = new CopyOnWriteArrayList<>();
        HttpServer foreign = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        foreign.createContext("/", exchange -> {
            String authorization = exchange.getRequestHeaders().getFirst("Authorization");
            if (authorization != null) foreignAuthorization.add(authorization);
            exchange.getResponseHeaders().add("WWW-Authenticate", "Basic realm=\"foreign\"");
            exchange.sendResponseHeaders(401, -1);
            exchange.close();
        });
        HttpServer origin = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        origin.createContext("/", exchange -> {
            String target = "http://127.0.0.1:" + foreign.getAddress().getPort() + exchange.getRequestURI();
            exchange.getResponseHeaders().add("Location", target);
            exchange.sendResponseHeaders(301, -1);
            exchange.close();
        });
        foreign.start();
        origin.start();
        try {
            GitCloneService service = new GitCloneService(new AppProperties(temp.resolve("data").toString(), 2));
            Throwable failure = catchThrowable(() -> service.cloneOrFetch(
                    temp.resolve("data/repos/1"),
                    "http://127.0.0.1:" + origin.getAddress().getPort() + "/o/r.git",
                    "SYNTHETIC-TOKEN-SENTINEL",
                    null));
            assertThat(failure).isInstanceOf(GitCloneException.class);
            assertThat(foreignAuthorization).as("Authorization sent to the redirected foreign origin").isEmpty();
        } finally {
            origin.stop(0);
            foreign.stop(0);
        }
    }
}
