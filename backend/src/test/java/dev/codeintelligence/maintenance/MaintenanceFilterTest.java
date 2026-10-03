package dev.codeintelligence.maintenance;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class MaintenanceFilterTest {
    private final MaintenanceGate gate = new MaintenanceGate();
    private final MaintenanceFilter filter = new MaintenanceFilter(gate);
    private final UUID id = UUID.randomUUID();

    @ParameterizedTest
    @CsvSource({
        "GET,/api/auth/github/native/callback",
        "GET,/login/oauth2/code/github",
        "GET,/oauth2/authorization/github",
        "POST,/api/auth/pat",
        "GET,/api/projects",
        "GET,/assets/app.js",
        "POST,/api/desktop/paths",
        "GET,/api/desktop/maintenance",
        "POST,/api/desktop/maintenance/",
        "POST,/api/desktop/maintenance;extra",
        "POST,//api/desktop/maintenance",
        "POST,/actuator/health",
        "GET,/actuator/health/",
        "GET,/actuator/info"
    })
    void barrierStopsNewRequestsBeforeAnyDownstreamAuthentication(String method, String path) throws Exception {
        gate.begin(id);
        var chain = mock(FilterChain.class);
        var response = new MockHttpServletResponse();
        filter.doFilter(new MockHttpServletRequest(method, path), response, chain);
        assertThat(response.getStatus()).isEqualTo(503);
        assertThat(response.getContentAsString()).contains("DESKTOP_MAINTENANCE_ACTIVE");
        verifyNoInteractions(chain);
    }

    @ParameterizedTest
    @CsvSource({"POST,/api/desktop/maintenance", "GET,/actuator/health"})
    void exactControlAndHealthRemainReachableDuringDrain(String method, String path) throws Exception {
        gate.begin(id);
        var request = new MockHttpServletRequest(method, path);
        var response = new MockHttpServletResponse();
        var chain = mock(FilterChain.class);
        filter.doFilter(request, response, chain);
        verify(chain).doFilter(request, response);
        assertThat(gate.snapshot(gate.current(id), 0).activeRequests()).isZero();
    }

    @Test
    void aPreviouslyAdmittedRequestRemainsCountedAcrossTheWholeChainAndItsExceptions() {
        var request = new MockHttpServletRequest("POST", "/api/projects");
        assertThatThrownBy(() -> filter.doFilter(request, new MockHttpServletResponse(), (req, res) -> {
                    gate.begin(id);
                    assertThat(gate.snapshot(gate.current(id), 0).activeRequests())
                            .isEqualTo(1);
                    throw new ServletException("synthetic failure");
                }))
                .isInstanceOf(ServletException.class);
        assertThat(gate.snapshot(gate.current(id), 0).state()).isEqualTo("DRAINED");
    }

    @Test
    void asyncReadOnlySseDoesNotHoldAWriterOrHttpLeaseAfterFilterReturns() throws Exception {
        var request = new MockHttpServletRequest("GET", "/api/jobs/1/events");
        request.setAsyncSupported(true);
        filter.doFilter(request, new MockHttpServletResponse(), (req, res) -> {
            request.startAsync();
            gate.begin(id);
            assertThat(gate.snapshot(gate.current(id), 0).activeRequests()).isEqualTo(1);
        });
        assertThat(request.isAsyncStarted()).isTrue();
        assertThat(gate.snapshot(gate.current(id), 0).state()).isEqualTo("DRAINED");
    }

    @Test
    void controlMatcherIsExactAndHonorsAConfiguredServletContext() {
        var request = new MockHttpServletRequest("POST", "/context/api/desktop/maintenance");
        request.setContextPath("/context");
        assertThat(MaintenanceFilter.isControlRequest(request)).isTrue();
        request.setRequestURI("/context/api/desktop/maintenance/other");
        assertThat(MaintenanceFilter.isControlRequest(request)).isFalse();
    }

    @Test
    void servletRegistrationPrecedesSessionAndSecurityFilterOrders() {
        var registration = new MaintenanceConfiguration().maintenanceFilter(gate);
        assertThat(registration.getOrder()).isLessThan(-10000);
        assertThat(registration.getUrlPatterns()).containsExactly("/*");
        assertThat(registration.getFilter()).isInstanceOf(MaintenanceFilter.class);
    }
}
