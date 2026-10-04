import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.nio.channels.ServerSocketChannel;
import java.util.Arrays;

/** Disposable Java 21 peer for the real Windows AF_UNIX bridge tests. */
class PrivateUnixProbe {
    private static String connectReason(Exception error) {
        // OpenJDK 21 Windows NET_ThrowNew uses fixed Winsock messages. Match whole
        // strings only; never copy exception text (which may contain a path).
        return switch (String.valueOf(error.getMessage())) {
            case "Permission denied: connect" -> "ACCESS_DENIED";
            case "Connection refused: connect" -> "REFUSED";
            case "Invalid argument: connect" -> "INVALID_ARGUMENT";
            case "Cannot assign requested address: connect" -> "ADDRESS_UNAVAILABLE";
            case "Connection timed out: connect" -> "TIMED_OUT";
            case "Unrecognized Windows Sockets error: 2: connect",
                 "Unrecognized Windows Sockets error: 3: connect" -> "PATH_NOT_FOUND";
            default -> "OTHER";
        };
    }

    public static void main(String[] args) throws Exception {
        if (args[1].equals("listen")) {
            // Independent Java listener for the native sharing regression. Keep
            // its backlog alive until the test owner closes stdin; no payloads.
            try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
                server.bind(UnixDomainSocketAddress.of(args[0]));
                System.err.println("LISTENING");
                System.err.flush();
                System.in.read();
            } catch (Exception error) {
                System.err.println("WINDOWS_JAVA_PROBE_OPEN_FAILED");
                System.exit(1);
            }
            return;
        }
        byte[] request = System.in.readAllBytes();
        String phase = "OPEN";
        boolean failed = false;
        try (SocketChannel channel = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            phase = "CONNECT";
            channel.connect(UnixDomainSocketAddress.of(args[0]));
            if (args[1].equals("connect")) return;
            phase = "WRITE";
            ByteBuffer input = ByteBuffer.wrap(request);
            while (input.hasRemaining()) channel.write(input);
            if (args[1].equals("hold") || args[1].equals("extra")) {
                System.err.println("WRITTEN");
                System.err.flush();
                Thread.sleep(400);
            }
            if (args[1].equals("extra")) channel.write(ByteBuffer.wrap(new byte[] {0}));
            phase = "FIN";
            channel.shutdownOutput();
            phase = "PREFIX";
            ByteBuffer prefix = ByteBuffer.allocate(4);
            while (prefix.hasRemaining()) {
                if (channel.read(prefix) < 0) {
                    if (args[1].equals("extra") && prefix.position() == 0) return;
                    throw new IllegalStateException("Truncated response prefix");
                }
            }
            phase = "LENGTH";
            int size = prefix.flip().getInt();
            if (size < 2 || size > 4 * 1024 * 1024) throw new IllegalStateException("Response limit");
            phase = "BODY";
            byte[] response = new byte[size];
            ByteBuffer body = ByteBuffer.wrap(response);
            while (body.hasRemaining()) if (channel.read(body) < 0) throw new IllegalStateException("Truncated response");
            phase = "EOF";
            if (channel.read(ByteBuffer.allocate(1)) != -1) throw new IllegalStateException("Response lacks EOF");
            phase = "OUTPUT";
            System.out.write(response);
            Arrays.fill(response, (byte) 0);
        } catch (Exception error) {
            // Fixed test-only enum; never publish exception text, paths or payloads.
            String reason = phase.equals("CONNECT") ? "_" + connectReason(error) : "";
            System.err.println("WINDOWS_JAVA_PROBE_" + phase + reason + "_FAILED");
            failed = true;
        } finally {
            Arrays.fill(request, (byte) 0);
        }
        if (failed) System.exit(1);
    }
}
