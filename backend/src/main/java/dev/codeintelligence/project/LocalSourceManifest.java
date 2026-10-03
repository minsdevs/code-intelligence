package dev.codeintelligence.project;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/** Binary, length-framed manifest. Git blob SHA-1 values are deliberately not used here. */
final class LocalSourceManifest {
    private final MessageDigest digest = sha256();
    private int count;
    private long bytes;
    private String previousPath;
    private boolean finished;

    LocalSourceManifest(String policyVersion, String limitsSha256) {
        string(digest, "code-intelligence-local-manifest-v1");
        string(digest, policyVersion);
        string(digest, limitsSha256);
    }

    void add(String path, long size, byte[] contentSha256) {
        if (finished
                || size < 0
                || contentSha256.length != 32
                || previousPath != null && LocalSourcePolicy.comparePaths(previousPath, path) >= 0) {
            throw new IllegalStateException("Invalid local source manifest entry.");
        }
        digest.update((byte) 1);
        string(digest, path);
        string(digest, "REGULAR_FILE");
        number(digest, size);
        digest.update(contentSha256);
        count++;
        bytes = Math.addExact(bytes, size);
        previousPath = path;
    }

    String finish() {
        if (finished) throw new IllegalStateException("Local source manifest is already complete.");
        finished = true;
        digest.update((byte) 0);
        number(digest, count);
        number(digest, bytes);
        return HexFormat.of().formatHex(digest.digest());
    }

    int count() {
        return count;
    }

    long bytes() {
        return bytes;
    }

    static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable.");
        }
    }

    static void string(MessageDigest digest, String value) {
        byte[] encoded = value.getBytes(StandardCharsets.UTF_8);
        digest.update(ByteBuffer.allocate(Integer.BYTES).putInt(encoded.length).array());
        digest.update(encoded);
    }

    static void number(MessageDigest digest, long value) {
        digest.update(ByteBuffer.allocate(Long.BYTES).putLong(value).array());
    }
}
