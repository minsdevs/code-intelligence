package dev.codeintelligence.ai;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.DateTimeException;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.Objects;
import java.util.function.LongSupplier;
import org.springframework.stereotype.Component;

/**
 * Process-scoped, one-use budget confirmation bound to the caller's current policy/settings state.
 * Only token hashes are retained. Each issue replaces that owner's previous confirmation, including
 * when the binding is unchanged. This is consent, not a cost reservation or a main-process permit.
 */
@Component
public final class AiBudgetApprovalStore {
    static final Duration LIFETIME = Duration.ofMinutes(5);
    private static final int MAX_OWNERS = 1024;
    private final Map<Long, Pending> pending = new HashMap<>();
    private final SecureRandom random = new SecureRandom();
    private final Clock clock;
    private final LongSupplier ticker;
    private Instant wallHighWater;
    private long nanosHighWater;

    private record Pending(byte[] tokenHash, String binding, long issuedNanos, Instant expiresAt) {}

    private record Observation(Instant wallTime, long nanos) {}

    public AiBudgetApprovalStore() {
        this(Clock.systemUTC(), System::nanoTime);
    }

    AiBudgetApprovalStore(Clock clock, LongSupplier ticker) {
        this.clock = Objects.requireNonNull(clock, "clock");
        this.ticker = Objects.requireNonNull(ticker, "ticker");
    }

    public synchronized String issue(long owner, String binding) {
        if (owner <= 0 || !isDigest(binding)) throw new IllegalArgumentException("Invalid budget approval binding.");
        Observation now = observeAndExpire();
        if (!pending.containsKey(owner) && pending.size() >= MAX_OWNERS) {
            throw new AiRequestPlanRequiredException();
        }
        Instant expiresAt;
        try {
            expiresAt = now.wallTime().plus(LIFETIME);
        } catch (DateTimeException | ArithmeticException invalidClock) {
            pending.clear();
            throw new AiRequestPlanRequiredException();
        }
        byte[] bytes = new byte[32];
        String token;
        try {
            random.nextBytes(bytes);
            token = HexFormat.of().formatHex(bytes);
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
        pending.put(owner, new Pending(hash(token), binding, now.nanos(), expiresAt));
        return token;
    }

    public synchronized void consume(long owner, String token, String binding) {
        if (owner <= 0 || !isDigest(token)) throw new AiRequestPlanRequiredException();
        observeAndExpire();
        Pending approval = pending.get(owner);
        if (approval == null || !MessageDigest.isEqual(approval.tokenHash(), hash(token))) {
            throw new AiRequestPlanRequiredException();
        }
        // An authentic owner/token pair is spent even if its policy or settings have changed back.
        pending.remove(owner);
        if (!isDigest(binding)
                || !MessageDigest.isEqual(
                        approval.binding().getBytes(StandardCharsets.US_ASCII),
                        binding.getBytes(StandardCharsets.US_ASCII))) {
            throw new AiRequestPlanRequiredException();
        }
    }

    /** Invalidating an owner never depends on either clock being available or trustworthy. */
    public synchronized void invalidate(long owner) {
        if (owner <= 0) throw new IllegalArgumentException("Invalid budget approval owner.");
        pending.remove(owner);
    }

    private Observation observeAndExpire() {
        Instant wallTime;
        long nanos;
        try {
            wallTime = Objects.requireNonNull(clock.instant());
            nanos = ticker.getAsLong();
        } catch (RuntimeException unavailableClock) {
            pending.clear();
            throw new AiRequestPlanRequiredException();
        }
        if (wallHighWater != null) {
            boolean wallRollback = wallTime.isBefore(wallHighWater);
            // Subtraction supports nanoTime's arbitrary signed origin and ordinary signed wrap.
            // An interval exceeding its supported half-range also fails closed.
            boolean nanosRollback = nanos - nanosHighWater < 0;
            if (!wallRollback) wallHighWater = wallTime;
            if (!nanosRollback) nanosHighWater = nanos;
            if (wallRollback || nanosRollback) {
                pending.clear();
                throw new AiRequestPlanRequiredException();
            }
        } else {
            wallHighWater = wallTime;
            nanosHighWater = nanos;
        }
        pending.values()
                .removeIf(p -> nanos - p.issuedNanos() < 0
                        || nanos - p.issuedNanos() >= LIFETIME.toNanos()
                        || !wallTime.isBefore(p.expiresAt()));
        return new Observation(wallTime, nanos);
    }

    private static boolean isDigest(String value) {
        if (value == null || value.length() != 64) return false;
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (!(character >= '0' && character <= '9') && !(character >= 'a' && character <= 'f')) return false;
        }
        return true;
    }

    private static byte[] hash(String token) {
        byte[] encoded = token.getBytes(StandardCharsets.US_ASCII);
        try {
            return MessageDigest.getInstance("SHA-256").digest(encoded);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable.");
        } finally {
            Arrays.fill(encoded, (byte) 0);
        }
    }
}
