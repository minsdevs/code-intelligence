package dev.codeintelligence.analysis.ts;

import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/** Exact, out-of-band leaf certificate trust for a single loopback analyzer origin. */
final class TsAnalyzerTls {
    private TsAnalyzerTls() {}

    static SSLContext context(TsAnalyzerProperties properties) {
        if (!properties.pinnedTls()) throw new IllegalArgumentException("Analyzer TLS pin is required");
        try {
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, new TrustManager[] {trustManager(properties)}, null);
            return context;
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("Analyzer TLS initialization failed");
        }
    }

    static X509TrustManager trustManager(TsAnalyzerProperties properties) {
        byte[] expectedPin = HexFormat.of().parseHex(properties.tlsCertSha256());
        byte[] expectedIp = literalIp(URI.create(properties.baseUrl()).getHost());
        return new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                throw new CertificateException("Analyzer client certificate trust is not configured");
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                if (chain == null || chain.length == 0 || chain[0] == null) {
                    throw new CertificateException("Analyzer server certificate is missing");
                }
                X509Certificate leaf = chain[0];
                try {
                    // TLS proves possession of this exact provisioned leaf's key. System CA trust is not used.
                    byte[] actualPin = MessageDigest.getInstance("SHA-256").digest(leaf.getEncoded());
                    if (!MessageDigest.isEqual(expectedPin, actualPin)) {
                        throw new CertificateException("Analyzer certificate pin mismatch");
                    }
                    leaf.checkValidity();
                    var names = leaf.getSubjectAlternativeNames();
                    boolean matches = names != null && names.stream().anyMatch(name -> ipSanMatches(name, expectedIp));
                    if (!matches) throw new CertificateException("Analyzer certificate IP identity mismatch");
                } catch (GeneralSecurityException e) {
                    // Neither supplied material nor nested provider error text belongs in diagnostics.
                    throw new CertificateException("Analyzer server certificate rejected");
                }
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        };
    }

    private static boolean ipSanMatches(List<?> name, byte[] expectedIp) {
        if (name.size() < 2 || !Integer.valueOf(7).equals(name.get(0))) return false;
        if (!(name.get(1) instanceof String text)) return false;
        byte[] actualIp = literalIp(text);
        return actualIp != null && Arrays.equals(expectedIp, actualIp);
    }

    private static byte[] literalIp(String value) {
        if (value == null) return null;
        String literal = value.startsWith("[") && value.endsWith("]") ? value.substring(1, value.length() - 1) : value;
        // Restrict parsing to numeric literals: a certificate SAN must never trigger DNS resolution.
        if (!literal.matches("[0-9.]+") && !(literal.contains(":") && literal.matches("[0-9a-fA-F:]+"))) {
            return null;
        }
        try {
            return InetAddress.getByName(literal).getAddress();
        } catch (UnknownHostException e) {
            return null;
        }
    }
}
