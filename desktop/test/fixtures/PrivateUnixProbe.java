import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.util.Arrays;

/** Disposable Java 21 peer for the real Windows AF_UNIX bridge tests. */
class PrivateUnixProbe {
    public static void main(String[] args) throws Exception {
        byte[] request = System.in.readAllBytes();
        String phase = "OPEN";
        try (SocketChannel channel = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            phase = "CONNECT";
            channel.connect(UnixDomainSocketAddress.of(args[0]));
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
            System.err.println("WINDOWS_JAVA_PROBE_" + phase + "_FAILED");
            throw error;
        } finally {
            Arrays.fill(request, (byte) 0);
        }
    }
}
