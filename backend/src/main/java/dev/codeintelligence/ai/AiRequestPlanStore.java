package dev.codeintelligence.ai;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;
import java.util.function.LongSupplier;
import org.springframework.stereotype.Component;

/**
 * Process-scoped one-use consent, not a durable cost ledger or dispatch permit. Only hashes and
 * metadata are retained. Restart/restore cannot revive an approval; every new process starts empty.
 */
@Component
public final class AiRequestPlanStore {
    static final Duration LIFETIME = Duration.ofMinutes(10);
    private static final int MAX_TOTAL = 1024;
    private static final int MAX_PER_USER = 32;
    private final Map<String, Pending> pending = new HashMap<>();
    private final SecureRandom random = new SecureRandom();
    private final Clock clock;
    private final LongSupplier ticker;

    record Issued(String requestPlanToken, String requestId, Instant expiresAt) {
        @Override
        public String toString() {
            return "Issued[redacted]";
        }
    }

    private record Pending(
            long userId,
            String binding,
            String requestId,
            long issuedNanos,
            Instant expiresAt,
            AiDesktopGateway.Quote quote) {}

    record Consumed(String requestId, AiDesktopGateway.Quote quote) {}

    public AiRequestPlanStore() {
        this(Clock.systemUTC(), System::nanoTime);
    }

    AiRequestPlanStore(Clock clock, LongSupplier ticker) {
        this.clock = clock;
        this.ticker = ticker;
    }

    synchronized Issued issue(long userId, String binding) {
        if (userId <= 0 || binding == null || !binding.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("Invalid request plan binding.");
        }
        expire();
        if (pending.size() >= MAX_TOTAL
                || pending.values().stream().filter(p -> p.userId() == userId).count() >= MAX_PER_USER) {
            throw new AiBusyException();
        }
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        String token = HexFormat.of().formatHex(bytes);
        java.util.Arrays.fill(bytes, (byte) 0);
        String requestId = UUID.randomUUID().toString();
        Instant expiresAt = clock.instant().plus(LIFETIME);
        pending.put(hash(token), new Pending(userId, binding, requestId, ticker.getAsLong(), expiresAt, null));
        return new Issued(token, requestId, expiresAt);
    }

    synchronized String consume(long userId, String token, String binding) {
        return consumePlan(userId, token, binding).requestId();
    }

    synchronized void attachQuote(Issued issued, AiDesktopGateway.Quote quote) {
        expire();
        String key = hash(issued.requestPlanToken());
        Pending plan = pending.get(key);
        if (plan == null
                || plan.quote() != null
                || quote == null
                || !plan.requestId().equals(quote.reservation().requestId().toString()))
            throw new AiRequestPlanRequiredException();
        pending.put(
                key,
                new Pending(
                        plan.userId(), plan.binding(), plan.requestId(), plan.issuedNanos(), plan.expiresAt(), quote));
    }

    synchronized void discard(Issued issued) {
        if (issued == null) return;
        String key = hash(issued.requestPlanToken());
        Pending plan = pending.get(key);
        if (plan != null && plan.requestId().equals(issued.requestId())) pending.remove(key);
    }

    synchronized Consumed consumePlan(long userId, String token, String binding) {
        expire();
        if (token == null || !token.matches("[0-9a-f]{64}")) throw new AiRequestPlanRequiredException();
        String key = hash(token);
        Pending plan = pending.get(key);
        if (plan == null || plan.userId() != userId) throw new AiRequestPlanRequiredException();
        // A mismatch burns this owner's approval. It can never later authorize changed-back data.
        pending.remove(key);
        if (binding == null
                || !MessageDigest.isEqual(
                        plan.binding().getBytes(StandardCharsets.US_ASCII),
                        binding.getBytes(StandardCharsets.US_ASCII))) {
            throw new AiRequestPlanRequiredException();
        }
        return new Consumed(plan.requestId(), plan.quote());
    }

    private void expire() {
        long now = ticker.getAsLong();
        Instant wallTime = clock.instant();
        pending.values()
                .removeIf(p -> now - p.issuedNanos() >= LIFETIME.toNanos() || !wallTime.isBefore(p.expiresAt()));
    }

    static String hash(String value) {
        try {
            return HexFormat.of()
                    .formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable.", impossible);
        }
    }
}
