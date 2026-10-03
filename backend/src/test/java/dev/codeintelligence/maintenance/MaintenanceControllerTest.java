package dev.codeintelligence.maintenance;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import dev.codeintelligence.common.security.AuthenticatedUser;
import dev.codeintelligence.common.security.CredentialKind;
import java.util.UUID;
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.web.server.ResponseStatusException;

class MaintenanceControllerTest {
    private static final String ID = "ba226a6f-6d2f-4b6e-b89d-58c2c7ed0229";
    private final MaintenanceService service = mock(MaintenanceService.class);
    private final MaintenanceController controller = new MaintenanceController(service);
    private final AuthenticatedUser user = new AuthenticatedUser(7, null, "local", null, null, CredentialKind.LOCAL);

    @ParameterizedTest
    @EnumSource(MaintenanceService.Operation.class)
    void acceptsOnlyTheFixedCommandAndForwardsMainCapability(MaintenanceService.Operation operation) {
        var expected = new MaintenanceGate.View(ID, "DRAINED", 0, 0, 0);
        when(service.control(UUID.fromString(ID), operation, user, "synthetic-path-token"))
                .thenReturn(expected);
        assertThat(controller.control(body(ID, operation.name()), "synthetic-path-token", user))
                .isEqualTo(expected);
        verify(service).control(UUID.fromString(ID), operation, user, "synthetic-path-token");
    }

    @ParameterizedTest
    @MethodSource("invalidBodies")
    void invalidInputHasNoAdmissionOrDatabaseSideEffects(String body) {
        assertThatThrownBy(() -> controller.control(body, "synthetic-path-token", user))
                .isInstanceOfSatisfying(
                        ResponseStatusException.class,
                        error -> assertThat(error.getStatusCode().value()).isEqualTo(400));
        verifyNoInteractions(service);
    }

    private static Stream<String> invalidBodies() {
        return Stream.of(
                null,
                "",
                "null",
                "[]",
                "{}",
                "{",
                body(ID.toUpperCase(), "BEGIN"),
                body("1-1-1-1-1", "BEGIN"),
                body(ID + " ", "BEGIN"),
                body(ID + "\\n", "BEGIN"),
                body(ID, "begin"),
                body(ID, "BEGIN "),
                body(ID, "CANCEL"),
                "{\"transactionId\":\"" + ID + "\",\"operation\":null}",
                "{\"transactionId\":7,\"operation\":\"BEGIN\"}",
                "{\"transactionId\":\"" + ID + "\"}",
                "{\"operation\":\"BEGIN\"}",
                body(ID, "BEGIN").replace("}", ",\"extra\":true}"),
                body(ID, "BEGIN").replace("}", ",\"operation\":\"END\"}"),
                body(ID, "BEGIN").replace("}", ",\"transactionId\":\"" + ID + "\"}"),
                body(ID, "BEGIN") + " {}",
                " ".repeat(257) + body(ID, "BEGIN"));
    }

    private static String body(String id, String operation) {
        return "{\"transactionId\":\"" + id + "\",\"operation\":\"" + operation + "\"}";
    }
}
