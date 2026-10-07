package dev.codeintelligence.job;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Loopback byte relay between the backend's analyzer client and the real analyzer process. It
 * never changes bytes; it only observes the first {@code POST /analyze} of an armed connection and
 * can withhold that response (deliver later or drop) so a kill or cancel lands deterministically
 * while the worker request is in flight.
 */
final class AnalyzerRelay implements AutoCloseable {

    enum Decision {
        DELIVER,
        DROP
    }

    static final class Hold {
        private final CountDownLatch requestSeen = new CountDownLatch(1);
        private final CountDownLatch responseArrived = new CountDownLatch(1);
        private final CountDownLatch decided = new CountDownLatch(1);
        private final CountDownLatch connectionClosed = new CountDownLatch(1);
        private volatile Decision decision;
        private volatile boolean clientWriteFailed;

        void awaitRequest() throws InterruptedException {
            if (!requestSeen.await(60, TimeUnit.SECONDS)) throw new IllegalStateException("analyze request not seen");
        }

        boolean awaitResponse(long seconds) throws InterruptedException {
            return responseArrived.await(seconds, TimeUnit.SECONDS);
        }

        boolean responseArrived() {
            return responseArrived.getCount() == 0;
        }

        void decide(Decision value) {
            decision = value;
            decided.countDown();
        }

        boolean awaitClosed(long seconds) throws InterruptedException {
            return connectionClosed.await(seconds, TimeUnit.SECONDS);
        }

        /** True when the withheld result could no longer be written to the backend connection. */
        boolean clientWriteFailed() {
            return clientWriteFailed;
        }

        private Decision await() throws InterruptedException {
            if (!decided.await(180, TimeUnit.SECONDS)) return Decision.DROP;
            return decision;
        }
    }

    private static final byte[] ANALYZE = "POST /analyze".getBytes(StandardCharsets.US_ASCII);

    private final ServerSocket server;
    private final AtomicReference<Hold> armed = new AtomicReference<>();
    private volatile int upstreamPort;

    AnalyzerRelay() throws IOException {
        server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
        Thread.ofVirtual().name("analyzer-relay-accept").start(this::accept);
    }

    String url() {
        return "http://127.0.0.1:" + server.getLocalPort();
    }

    void target(int port) {
        upstreamPort = port;
    }

    /** The next connection that carries an analyze request is held under this arm. */
    Hold arm() {
        Hold hold = new Hold();
        if (!armed.compareAndSet(null, hold)) throw new IllegalStateException("relay already armed");
        return hold;
    }

    void disarm() {
        Hold hold = armed.getAndSet(null);
        if (hold != null) hold.decide(Decision.DROP);
    }

    @Override
    public void close() throws IOException {
        disarm();
        server.close();
    }

    private void accept() {
        while (!server.isClosed()) {
            try {
                Socket client = server.accept();
                Thread.ofVirtual().name("analyzer-relay-connection").start(() -> relay(client));
            } catch (IOException closed) {
                return;
            }
        }
    }

    private void relay(Socket client) {
        Socket upstream = new Socket();
        Connection connection = new Connection(client, upstream);
        try {
            upstream.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), upstreamPort), 5_000);
        } catch (IOException unavailable) {
            connection.close();
            return;
        }
        Thread.ofVirtual().name("analyzer-relay-response").start(connection::pumpResponse);
        connection.pumpRequest();
    }

    private final class Connection {
        private final Socket client;
        private final Socket upstream;
        private volatile Hold hold;

        private Connection(Socket client, Socket upstream) {
            this.client = client;
            this.upstream = upstream;
        }

        private void pumpRequest() {
            byte[] buffer = new byte[64 * 1024];
            byte[] window = new byte[0];
            try (InputStream in = client.getInputStream();
                    OutputStream out = upstream.getOutputStream()) {
                int read;
                while ((read = in.read(buffer)) >= 0) {
                    if (hold == null) {
                        byte[] joined = new byte[window.length + read];
                        System.arraycopy(window, 0, joined, 0, window.length);
                        System.arraycopy(buffer, 0, joined, window.length, read);
                        if (contains(joined, ANALYZE)) {
                            Hold next = armed.getAndSet(null);
                            if (next != null) {
                                hold = next;
                                next.requestSeen.countDown();
                            }
                        }
                        int keep = Math.min(joined.length, ANALYZE.length - 1);
                        window = java.util.Arrays.copyOfRange(joined, joined.length - keep, joined.length);
                    }
                    out.write(buffer, 0, read);
                    out.flush();
                }
            } catch (IOException ignored) {
                // Either side closed; the response pump decides what the backend observes.
            } finally {
                if (hold == null) close();
            }
        }

        private void pumpResponse() {
            byte[] buffer = new byte[64 * 1024];
            boolean decidedToDeliver = false;
            try (InputStream in = upstream.getInputStream()) {
                OutputStream out = client.getOutputStream();
                int read;
                while ((read = in.read(buffer)) >= 0) {
                    Hold current = hold;
                    if (current != null && !decidedToDeliver) {
                        current.responseArrived.countDown();
                        if (current.await() == Decision.DROP) return;
                        decidedToDeliver = true;
                    }
                    try {
                        out.write(buffer, 0, read);
                        out.flush();
                    } catch (IOException clientGone) {
                        if (current != null) current.clientWriteFailed = true;
                        return;
                    }
                }
            } catch (IOException | InterruptedException ignored) {
                // Upstream died (for example the owned analyzer was SIGKILLed): close the client.
            } finally {
                close();
            }
        }

        private void close() {
            try {
                client.close();
            } catch (IOException ignored) {
                // Best effort for a test relay.
            }
            try {
                upstream.close();
            } catch (IOException ignored) {
                // Best effort for a test relay.
            }
            Hold current = hold;
            if (current != null) current.connectionClosed.countDown();
        }
    }

    private static boolean contains(byte[] haystack, byte[] needle) {
        outer:
        for (int i = 0; i + needle.length <= haystack.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) continue outer;
            }
            return true;
        }
        return false;
    }
}
