package dev.codeintelligence.github;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.sun.net.httpserver.HttpServer;
import dev.codeintelligence.common.AppProperties;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.StoredConfig;
import org.eclipse.jgit.transport.URIish;
import org.eclipse.jgit.transport.http.HttpConnection;
import org.eclipse.jgit.transport.http.HttpConnectionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * G-SEC GitHub import egress (05 §2: re-check scheme/host/IP/credential on every redirect and never
 * forward Authorization across origins). Two loopback HTTP servers stand in for the clone origin and
 * a foreign origin; the foreign one asks for Basic credentials after a redirect.
 *
 * <p>SEC-M-03: reproduced on 2026-10-07 (the foreign origin received the token three times). The
 * clone transport followed the initial redirect and the per-call credentials provider answered for
 * any URI; once the origin had challenged, JGit also re-sent the Basic header to the redirect
 * target. The HTTP connection factory is now bound to the remote's origin, so no connection to
 * another origin is opened for clone or fetch.
 */
class SecurityGitTransportRedirectTest {

    @TempDir
    Path temp;

    private final List<String> foreignRequests = new CopyOnWriteArrayList<>();
    private final List<String> foreignAuthorization = new CopyOnWriteArrayList<>();
    private HttpServer foreign;
    private HttpServer origin;

    @BeforeEach
    void startForeignOrigin() throws Exception {
        foreign = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        foreign.createContext("/", exchange -> {
            foreignRequests.add(exchange.getRequestURI().toString());
            String authorization = exchange.getRequestHeaders().getFirst("Authorization");
            if (authorization != null) foreignAuthorization.add(authorization);
            exchange.getResponseHeaders().add("WWW-Authenticate", "Basic realm=\"foreign\"");
            exchange.sendResponseHeaders(401, -1);
            exchange.close();
        });
        foreign.start();
    }

    @AfterEach
    void stopServers() {
        if (origin != null) origin.stop(0);
        foreign.stop(0);
    }

    /** The origin redirects every request; when {@code challengeFirst}, only after it saw credentials. */
    private String redirectingOrigin(boolean challengeFirst) throws Exception {
        origin = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        origin.createContext("/", exchange -> {
            if (challengeFirst && exchange.getRequestHeaders().getFirst("Authorization") == null) {
                exchange.getResponseHeaders().add("WWW-Authenticate", "Basic realm=\"origin\"");
                exchange.sendResponseHeaders(401, -1);
            } else {
                String target = "http://127.0.0.1:" + foreign.getAddress().getPort() + exchange.getRequestURI();
                exchange.getResponseHeaders().add("Location", target);
                exchange.sendResponseHeaders(301, -1);
            }
            exchange.close();
        });
        origin.start();
        return "http://127.0.0.1:" + origin.getAddress().getPort() + "/o/r.git";
    }

    private GitCloneService service() {
        return new GitCloneService(new AppProperties(temp.resolve("data").toString(), 2));
    }

    @Test
    void cloneCredentialsAreNeverSentToAnOriginReachedThroughARedirect() throws Exception {
        String remote = redirectingOrigin(false);
        Throwable failure = catchThrowable(
                () -> service().cloneOrFetch(temp.resolve("data/repos/1"), remote, "SYNTHETIC-TOKEN-SENTINEL", null));
        assertThat(failure).isInstanceOf(GitCloneException.class);
        assertThat(foreignAuthorization)
                .as("Authorization sent to the redirected foreign origin")
                .isEmpty();
        assertThat(foreignRequests)
                .as("requests that reached the foreign origin")
                .isEmpty();
    }

    @Test
    void credentialsAcceptedByTheOriginAreNotReplayedToARedirectTarget() throws Exception {
        String remote = redirectingOrigin(true);
        Throwable failure = catchThrowable(
                () -> service().cloneOrFetch(temp.resolve("data/repos/2"), remote, "SYNTHETIC-TOKEN-SENTINEL", null));
        assertThat(failure).isInstanceOf(GitCloneException.class);
        assertThat(foreignAuthorization)
                .as("Basic header replayed to the redirect target after the origin challenge")
                .isEmpty();
        assertThat(foreignRequests)
                .as("requests that reached the foreign origin")
                .isEmpty();
    }

    @Test
    void fetchOfAnExistingCloneDoesNotFollowACrossOriginRedirect() throws Exception {
        String remote = redirectingOrigin(false);
        Path target = temp.resolve("data/repos/3");
        try (Git git = Git.init().setDirectory(target.toFile()).call()) {
            StoredConfig config = git.getRepository().getConfig();
            config.setString("remote", "origin", "url", remote);
            config.setString("remote", "origin", "fetch", "+refs/heads/*:refs/remotes/origin/*");
            config.save();
        }
        Throwable failure =
                catchThrowable(() -> service().cloneOrFetch(target, remote, "SYNTHETIC-TOKEN-SENTINEL", "main"));
        assertThat(failure).isInstanceOf(GitCloneException.class);
        assertThat(foreignAuthorization).isEmpty();
        assertThat(foreignRequests)
                .as("requests that reached the foreign origin")
                .isEmpty();
    }

    @Test
    void theConnectionFactoryAdmitsOnlyTheRemoteSchemeHostAndPort() throws Exception {
        List<String> opened = new CopyOnWriteArrayList<>();
        HttpConnectionFactory recording = new HttpConnectionFactory() {
            @Override
            public HttpConnection create(URL url) {
                opened.add(url.toString());
                return null;
            }

            @Override
            public HttpConnection create(URL url, Proxy proxy) {
                return create(url);
            }
        };
        var factory =
                new GitCloneService.OriginBoundConnectionFactory(new URIish("https://github.com/o/r.git"), recording);
        for (String allowed : List.of(
                "https://github.com/o/r.git/info/refs?service=git-upload-pack",
                "https://GITHUB.com:443/o/r.git/git-upload-pack",
                "https://github.com/o/renamed.git/info/refs")) {
            factory.create(new URL(allowed), Proxy.NO_PROXY);
        }
        for (String refused : List.of(
                "http://github.com/o/r.git/info/refs",
                "https://github.com:8443/o/r.git/info/refs",
                "https://codeload.github.com/o/r/zip/main",
                "https://github.com.evil.example/o/r.git/info/refs",
                "https://evil.example/o/r.git/info/refs",
                "https://127.0.0.1/o/r.git/info/refs")) {
            assertThat(catchThrowable(() -> factory.create(new URL(refused))))
                    .as(refused)
                    .isInstanceOf(IOException.class);
        }
        assertThat(opened).hasSize(3);
    }
}
