package dev.codeintelligence.analysis.ts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.net.Proxy;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.CertificateExpiredException;
import java.security.cert.CertificateNotYetValidException;
import java.security.cert.X509Certificate;
import java.util.HexFormat;
import java.util.List;
import javax.net.ssl.X509TrustManager;
import org.junit.jupiter.api.Test;

/** Synthetic certificate doubles only: no identity/key generation, sockets, or credential storage. */
class TsAnalyzerTlsTest {
    private static final byte[] CERTIFICATE_BYTES =
            "public synthetic certificate bytes".getBytes(StandardCharsets.UTF_8);
    private static final String TOKEN = "b2".repeat(32);

    private static TsAnalyzerProperties properties(String host) throws Exception {
        String pin =
                HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(CERTIFICATE_BYTES));
        return new TsAnalyzerProperties("https://" + host + ":3040", 2, pin, TOKEN);
    }

    private static X509Certificate certificate(List<List<?>> names) throws Exception {
        X509Certificate certificate = mock(X509Certificate.class);
        when(certificate.getEncoded()).thenReturn(CERTIFICATE_BYTES);
        when(certificate.getSubjectAlternativeNames()).thenReturn(names);
        return certificate;
    }

    @Test
    void exactProvisionedLeafAndIpSanAreAcceptedAfterValidityCheck() throws Exception {
        for (String host : new String[] {"127.0.0.1", "[::1]"}) {
            X509Certificate leaf = certificate(List.of(List.of(7, host.equals("[::1]") ? "0:0:0:0:0:0:0:1" : host)));
            assertThatCode(() -> TsAnalyzerTls.trustManager(properties(host))
                            .checkServerTrusted(new X509Certificate[] {leaf}, "RSA"))
                    .doesNotThrowAnyException();
            verify(leaf).checkValidity();
        }
    }

    @Test
    void wrongLeafFailsEvenWhenLoopbackIdentityMatches() throws Exception {
        X509Certificate leaf = certificate(List.of(List.of(7, "127.0.0.1")));
        when(leaf.getEncoded()).thenReturn("different certificate".getBytes(StandardCharsets.UTF_8));
        assertRejected(TsAnalyzerTls.trustManager(properties("127.0.0.1")), leaf);
    }

    @Test
    void expiredAndNotYetValidPinnedCertificatesFail() throws Exception {
        X509TrustManager trust = TsAnalyzerTls.trustManager(properties("127.0.0.1"));
        for (CertificateException failure : new CertificateException[] {
            new CertificateExpiredException("synthetic detail"), new CertificateNotYetValidException("synthetic detail")
        }) {
            X509Certificate leaf = certificate(List.of(List.of(7, "127.0.0.1")));
            doThrow(failure).when(leaf).checkValidity();
            assertRejected(trust, leaf);
        }
    }

    @Test
    void pinnedCertificateStillRequiresIpSanAndDoesNotAcceptDnsOrCommonNameFallback() throws Exception {
        X509TrustManager trust = TsAnalyzerTls.trustManager(properties("127.0.0.1"));
        for (List<List<?>> names : List.<List<List<?>>>of(
                List.of(),
                List.of(List.of(2, "127.0.0.1")),
                List.of(List.of(2, "localhost")),
                List.of(List.of(7, "127.0.0.2")),
                List.of(List.of(7, "::1")),
                List.of(List.of(7, "localhost")))) {
            assertRejected(trust, certificate(names));
        }
        assertRejected(trust, certificate(null));
    }

    @Test
    void missingCertificatesAndClientTrustFailClosed() throws Exception {
        X509TrustManager trust = TsAnalyzerTls.trustManager(properties("127.0.0.1"));
        for (X509Certificate[] chain : new X509Certificate[][] {null, new X509Certificate[0], {null}}) {
            assertThatThrownBy(() -> trust.checkServerTrusted(chain, "RSA")).isInstanceOf(CertificateException.class);
        }
        assertThatThrownBy(() -> trust.checkClientTrusted(new X509Certificate[0], "RSA"))
                .isInstanceOf(CertificateException.class);
        assertThat(trust.getAcceptedIssuers()).isEmpty();
    }

    @Test
    void actualHttpClientRetainsTlsIdentityChecksAndCannotUseProxyOrRedirects() throws Exception {
        try (HttpClient client =
                TsAnalyzerClient.transport(properties("127.0.0.1")).build()) {
            assertThat(client.followRedirects()).isEqualTo(HttpClient.Redirect.NEVER);
            assertThat(client.proxy()).isPresent();
            assertThat(client.proxy().orElseThrow().select(URI.create("https://127.0.0.1:3040")))
                    .containsExactly(Proxy.NO_PROXY);
            assertThat(client.sslParameters().getEndpointIdentificationAlgorithm())
                    .isEqualTo("HTTPS");
            assertThat(client.sslParameters().getProtocols()).containsExactly("TLSv1.3", "TLSv1.2");
        }
    }

    private static void assertRejected(X509TrustManager trust, X509Certificate leaf) {
        assertThatThrownBy(() -> trust.checkServerTrusted(new X509Certificate[] {leaf}, "RSA"))
                .isInstanceOf(CertificateException.class)
                .hasMessage("Analyzer server certificate rejected")
                .hasNoCause();
    }
}
