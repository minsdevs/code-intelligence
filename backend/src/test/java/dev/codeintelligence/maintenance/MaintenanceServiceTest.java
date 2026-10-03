package dev.codeintelligence.maintenance;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.Mockito.RETURNS_DEEP_STUBS;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import dev.codeintelligence.auth.DesktopAuthProperties;
import dev.codeintelligence.common.security.AuthenticatedUser;
import dev.codeintelligence.common.security.CredentialKind;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.server.ResponseStatusException;

class MaintenanceServiceTest {
    private static final String IDENTITY = "synthetic-installation";
    private static final String TOKEN = "synthetic-main-path-token";
    private final MaintenanceGate gate = new MaintenanceGate();
    private final JdbcClient jdbc = mock(JdbcClient.class, RETURNS_DEEP_STUBS);
    private final DesktopAuthProperties desktop =
            new DesktopAuthProperties("synthetic-launch-token", IDENTITY, "http://127.0.0.1:4311");
    private final MaintenanceService service = new MaintenanceService(gate, jdbc, desktop, TOKEN);
    private final AuthenticatedUser user = new AuthenticatedUser(7, null, "local", null, null, CredentialKind.LOCAL);
    private final UUID id = UUID.randomUUID();

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"wrong-token", TOKEN + "\n", TOKEN + " ", "synthetic-main-path-toke"})
    void missingOrInexactMainCapabilityNeverTouchesDatabaseOrBarrier(String token) {
        forbidden(() -> service.control(id, MaintenanceService.Operation.BEGIN, user, token));
        verifyNoInteractions(jdbc);
        assertThat(gate.active()).isFalse();
    }

    @Test
    void localCredentialAndConfiguredDesktopAreMandatoryEvenWithTheMainCapability() {
        for (CredentialKind kind : new CredentialKind[] {CredentialKind.PAT, CredentialKind.OAUTH}) {
            var remote = new AuthenticatedUser(7, 99L, "remote", null, null, kind);
            forbidden(() -> service.control(id, MaintenanceService.Operation.BEGIN, remote, TOKEN));
        }
        forbidden(() -> service.control(id, MaintenanceService.Operation.BEGIN, null, TOKEN));
        var noDesktop = new MaintenanceService(
                gate, jdbc, new DesktopAuthProperties("", IDENTITY, desktop.allowedOrigin()), TOKEN);
        forbidden(() -> noDesktop.control(id, MaintenanceService.Operation.BEGIN, user, TOKEN));
        var noMainToken = new MaintenanceService(gate, jdbc, desktop, " ");
        forbidden(() -> noMainToken.control(id, MaintenanceService.Operation.BEGIN, user, " "));
        verifyNoInteractions(jdbc);
        assertThat(gate.active()).isFalse();
    }

    @Test
    void actualLocalOwnerMustMatchTheConfiguredInstallationAndWhitelistedIdentityTypes() {
        owner(false);
        forbidden(() -> service.control(id, MaintenanceService.Operation.BEGIN, user, TOKEN));
        assertThat(gate.active()).isFalse();
    }

    @Test
    void beginIsAlreadyClosedWhenItsDatabaseObservationStarts() {
        owner(true);
        when(jdbc.sql(contains("select count(*)")).query(Long.class).single()).thenAnswer(invocation -> {
            assertThat(gate.active()).isTrue();
            assertThatThrownBy(gate::admitRequest).isInstanceOf(ResponseStatusException.class);
            return 0L;
        });
        assertThat(service.control(id, MaintenanceService.Operation.BEGIN, user, TOKEN)
                        .state())
                .isEqualTo("DRAINED");
    }

    @Test
    void sqlQueuedRunningOrCancellingRowsPreventDrainWithoutAnExecutorLease() {
        owner(true);
        when(jdbc.sql(contains("where status in ('QUEUED', 'RUNNING', 'CANCELLING')"))
                        .query(Long.class)
                        .single())
                .thenReturn(3L, 0L);
        var begin = service.control(id, MaintenanceService.Operation.BEGIN, user, TOKEN);
        assertThat(begin.state()).isEqualTo("DRAINING");
        assertThat(begin.activeJobs()).isEqualTo(3);
        assertThat(service.control(id, MaintenanceService.Operation.STATUS, user, TOKEN)
                        .state())
                .isEqualTo("DRAINED");
    }

    @Test
    void countFailureOnBeginStatusOrEndKeepsTheBarrierClosed() {
        owner(true);
        when(jdbc.sql(contains("select count(*)")).query(Long.class).single())
                .thenThrow(new IllegalStateException("synthetic unavailable database"));
        for (var operation : MaintenanceService.Operation.values()) {
            assertThatThrownBy(() -> service.control(id, operation, user, TOKEN))
                    .isInstanceOf(IllegalStateException.class);
            assertThat(gate.active()).isTrue();
        }
        assertThatThrownBy(gate::admitRequest).isInstanceOf(ResponseStatusException.class);
    }

    @Test
    void completionDuringSqlRequiresAnotherStatusAndNeverUsesAnOlderEmptyResult() {
        owner(true);
        var request = gate.admitRequest();
        when(jdbc.sql(contains("select count(*)")).query(Long.class).single())
                .thenAnswer(invocation -> {
                    request.close();
                    return 0L;
                })
                .thenReturn(1L);
        var first = service.control(id, MaintenanceService.Operation.BEGIN, user, TOKEN);
        assertThat(first.state()).isEqualTo("DRAINING");
        assertThat(first.activeRequests()).isZero();
        var second = service.control(id, MaintenanceService.Operation.STATUS, user, TOKEN);
        assertThat(second.state()).isEqualTo("DRAINING");
        assertThat(second.activeJobs()).isEqualTo(1);
    }

    @Test
    void successfulEndReturnsThePriorStateAndReopensButASecondEndConflicts() {
        owner(true);
        when(jdbc.sql(contains("select count(*)")).query(Long.class).single()).thenReturn(0L);
        service.control(id, MaintenanceService.Operation.BEGIN, user, TOKEN);
        assertThat(service.control(id, MaintenanceService.Operation.END, user, TOKEN)
                        .state())
                .isEqualTo("DRAINED");
        assertThat(gate.active()).isFalse();
        assertThatThrownBy(() -> service.control(id, MaintenanceService.Operation.END, user, TOKEN))
                .isInstanceOfSatisfying(
                        ResponseStatusException.class,
                        error -> assertThat(error.getStatusCode().value()).isEqualTo(409));
    }

    private void owner(boolean allowed) {
        when(jdbc.sql(contains("identity_type in ('LOCAL', 'LOCAL_LINKED')"))
                        .param("userId", user.userId())
                        .param("localIdentity", IDENTITY)
                        .query(Boolean.class)
                        .single())
                .thenReturn(allowed);
    }

    private static void forbidden(Runnable action) {
        assertThatThrownBy(action::run)
                .isInstanceOfSatisfying(
                        ResponseStatusException.class,
                        error -> assertThat(error.getStatusCode().value()).isEqualTo(403));
    }
}
