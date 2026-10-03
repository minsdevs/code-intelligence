package dev.codeintelligence.ai;

import java.util.HashMap;
import java.util.Map;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import org.springframework.stereotype.Component;

/**
 * Serializes local admission with settings commits, not network operations. A call admitted before
 * OFF may still send/complete afterward. Counts are transient diagnostics, never a cost ledger or
 * durable restore-drain proof. The desktop runs one backend; other processes cannot share this gate.
 */
@Component
public class AiDispatchGate {
    private static final int MAX_ACTIVE = 2;
    private final Object monitor = new Object();
    private final Map<Long, Integer> activeByUser = new HashMap<>();
    private final AiSafetyPolicy safety;
    private int active;

    public AiDispatchGate(AiSafetyPolicy safety) {
        this.safety = safety;
    }

    String blockedReason() {
        return safety.blockedReason();
    }

    void requireSafety() {
        safety.requireAvailable();
    }

    <T> T control(Supplier<T> action) {
        synchronized (monitor) {
            return action.get();
        }
    }

    public int activeRequests(long userId) {
        synchronized (monitor) {
            return activeByUser.getOrDefault(userId, 0);
        }
    }

    <T> T call(long userId, BooleanSupplier allowed, Supplier<T> action) {
        synchronized (monitor) {
            safety.requireAvailable();
            if (!allowed.getAsBoolean()) throw new AiSettingsChangedException();
            if (active >= MAX_ACTIVE) throw new AiBusyException();
            active++;
            activeByUser.merge(userId, 1, Integer::sum);
        }
        try {
            return action.get();
        } finally {
            synchronized (monitor) {
                active--;
                activeByUser.compute(userId, (key, count) -> count == 1 ? null : count - 1);
            }
        }
    }
}
