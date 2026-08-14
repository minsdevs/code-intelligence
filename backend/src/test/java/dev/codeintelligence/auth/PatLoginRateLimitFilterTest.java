package dev.codeintelligence.auth;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class PatLoginRateLimitFilterTest {

    @Test
    void rejectsTheAttemptPastTheWindowCap() throws Exception {
        PatLoginRateLimitFilter filter = new PatLoginRateLimitFilter(new AuthProperties(2, 60));
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/auth/pat");
        request.setServletPath("/api/auth/pat");
        request.setRemoteAddr("203.0.113.9");

        MockHttpServletResponse first = new MockHttpServletResponse();
        filter.doFilter(request, first, (req, res) -> res.getWriter().write("ok"));
        assertThat(first.getStatus()).isEqualTo(200);

        MockHttpServletResponse second = new MockHttpServletResponse();
        filter.doFilter(request, second, (req, res) -> res.getWriter().write("ok"));
        assertThat(second.getStatus()).isEqualTo(200);

        MockHttpServletResponse third = new MockHttpServletResponse();
        filter.doFilter(request, third, (req, res) -> res.getWriter().write("ok"));
        assertThat(third.getStatus()).isEqualTo(429);
        assertThat(third.getContentAsString())
                .contains("Too many PAT login attempts")
                .doesNotContain("ghp_");
    }

    @Test
    void ignoresNonPatPaths() throws Exception {
        PatLoginRateLimitFilter filter = new PatLoginRateLimitFilter(new AuthProperties(1, 60));
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/auth/logout");
        request.setServletPath("/api/auth/logout");
        MockHttpServletResponse response = new MockHttpServletResponse();
        filter.doFilter(request, response, (req, res) -> res.getWriter().write("ok"));
        assertThat(response.getStatus()).isEqualTo(200);
    }
}
