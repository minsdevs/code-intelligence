package dev.codeintelligence.desktop;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class DesktopControlApplicationTest {
    @Test
    void rejectsUnknownArgumentsWithoutStartingSpring() {
        assertThat(DesktopControlApplication.run(new String[] {"--unknown"})).isEqualTo(2);
    }

    @Test
    void nativeLeaseEofPreservesWorkerExitCode() {
        var oldIn = System.in;
        var oldOut = System.out;
        try {
            System.setIn(new ByteArrayInputStream(new byte[0]));
            System.setOut(new java.io.PrintStream(new ByteArrayOutputStream(), true, StandardCharsets.UTF_8));
            assertThat(DesktopControlApplication.run(new String[] {"--ci-desktop-lease"}))
                    .isEqualTo(2);
        } finally {
            System.setIn(oldIn);
            System.setOut(oldOut);
        }
    }

    @Test
    void malformedManagedFramePreservesWorkerFailureCodeAndFixedReply() {
        var oldIn = System.in;
        var oldOut = System.out;
        var input = new byte[] {0, 0, 0, 1, '{'};
        var output = new ByteArrayOutputStream();
        try {
            System.setIn(new ByteArrayInputStream(input));
            System.setOut(new java.io.PrintStream(output, true, StandardCharsets.ISO_8859_1));
            assertThat(DesktopControlApplication.run(new String[] {"--ci-managed-process"}))
                    .isEqualTo(2);
        } finally {
            System.setIn(oldIn);
            System.setOut(oldOut);
        }
        byte[] bytes = output.toByteArray();
        assertThat(bytes.length).isGreaterThan(4);
        int size = ByteBuffer.wrap(bytes, 0, 4).getInt();
        assertThat(size).isEqualTo(bytes.length - 4);
        String json = new String(bytes, 4, size, StandardCharsets.UTF_8);
        var value = new JsonMapper().readTree(json);
        assertThat(value.size()).isEqualTo(3);
        assertThat(value.get("version").intValue()).isEqualTo(1);
        assertThat(value.get("kind").stringValue()).isEqualTo("ERROR");
        assertThat(value.get("code").stringValue()).isEqualTo("START_FAILED");
    }
}
