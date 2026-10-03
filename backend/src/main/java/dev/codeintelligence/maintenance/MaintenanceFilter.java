package dev.codeintelligence.maintenance;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.server.ResponseStatusException;

/** Registered outside/before session and security filters, including authentication callbacks. */
public final class MaintenanceFilter extends OncePerRequestFilter {
    private final MaintenanceGate gate;

    public MaintenanceFilter(MaintenanceGate gate) {
        this.gate = gate;
    }

    public static boolean isControlRequest(HttpServletRequest request) {
        return "POST".equals(request.getMethod())
                && (request.getContextPath() + MaintenanceController.PATH).equals(request.getRequestURI());
    }

    private static boolean isHealthRequest(HttpServletRequest request) {
        return "GET".equals(request.getMethod())
                && (request.getContextPath() + "/actuator/health").equals(request.getRequestURI());
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (isControlRequest(request) || isHealthRequest(request)) {
            chain.doFilter(request, response);
            return;
        }
        MaintenanceGate.RequestLease lease;
        try {
            lease = gate.admitRequest();
        } catch (ResponseStatusException unavailable) {
            response.setStatus(HttpServletResponse.SC_SERVICE_UNAVAILABLE);
            response.setContentType("application/problem+json");
            response.getWriter().write("{\"status\":503,\"code\":\"DESKTOP_MAINTENANCE_ACTIVE\"}");
            return;
        }
        try (lease) {
            // SSE subscribers release this HTTP lease when their controller returns. AI work
            // owns a separate writer lease, independent of emitter timeout/disconnection.
            chain.doFilter(request, response);
        }
    }
}
