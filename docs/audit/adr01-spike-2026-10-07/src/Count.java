// ADR-01 spike Java worker: reads source bytes on stdin and reports trivial counts plus its sandbox view.
public class Count {
  public static void main(String[] args) throws Exception {
    String s = new String(System.in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
    long identifiers = java.util.regex.Pattern.compile("[A-Za-z_][A-Za-z0-9_]*").matcher(s).results().count();
    String home;
    try { home = java.nio.file.Files.list(java.nio.file.Path.of(System.getProperty("user.home"))).count() + " entries"; } catch (Exception e) { home = "DENIED(" + e.getClass().getSimpleName() + ")"; }
    String net;
    try (var socket = new java.net.Socket()) { socket.connect(new java.net.InetSocketAddress("127.0.0.1", Integer.getInteger("port", 9)), 1000); net = "ALLOWED"; } catch (Exception e) { net = "DENIED(" + e.getMessage() + ")"; }
    System.out.println("{\"worker\":\"java " + System.getProperty("java.version") + "\",\"lines\":" + s.lines().count() + ",\"identifiers\":" + identifiers + ",\"userHome\":\"" + home + "\",\"userDirHome\":\"" + System.getProperty("user.home") + "\",\"tcp\":\"" + net + "\"}");
  }
}
