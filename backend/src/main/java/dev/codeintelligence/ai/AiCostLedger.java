package dev.codeintelligence.ai;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.stream.Collectors;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

/**
 * Internal PG projection, not an egress permit or a price estimator. The main adapter authenticates
 * its private channel and implements MainAuthority. None of these methods is an HTTP API.
 *
 * <p>Every mutation locks one installation row. Separate REQUIRES_NEW transactions keep committed
 * reservations/evidence independent of answer persistence. Main callbacks always happen before that
 * transaction, never while holding its database locks. Reconciliation requires main's dispatch
 * barrier; it does not itself stop a network request or modify the safety journal.
 */
@Service
public final class AiCostLedger {
    private static final String ZERO = "0".repeat(64);
    private static final Set<String> BINDING_FIELDS = Arrays.stream(DispatchBinding.class.getRecordComponents())
            .map(java.lang.reflect.RecordComponent::getName)
            .collect(Collectors.toUnmodifiableSet());

    public enum Status {
        RESERVED,
        DISPATCHED,
        UNKNOWN_HELD,
        SETTLED
    }

    public enum Operation {
        CHAT,
        EMBEDDING,
        CONNECTION_PROBE
    }

    public enum ReceiptType {
        USAGE,
        PROVEN_NOT_SENT
    }

    public enum UsageDimension {
        INPUT_TOKENS,
        OUTPUT_TOKENS,
        EMBEDDING_INPUT_TOKENS,
        CACHED_INPUT_TOKENS,
        CACHE_WRITE_TOKENS,
        REASONING_TOKENS,
        REQUESTS
    }

    /** No HTTP body, URL, key, prompt, arbitrary metadata map, or approval capability. */
    public record DispatchBinding(
            String mainEpoch,
            String provider,
            String model,
            Operation operation,
            String endpointId,
            String adapterVersion,
            String tokenizerId,
            String tokenizerVersion,
            String costContractSha256,
            String priceSha256,
            long settingsRevision,
            long policyRevision,
            String policySha256,
            long inputTokenUpperBound,
            long outputTokenMax,
            long embeddingInputTokenUpperBound,
            long wireBodyBytes,
            long validUntilEpochMs) {}

    public record Reservation(
            UUID requestId,
            String installationId,
            long ownerUserId,
            long projectId,
            long snapshotId,
            UUID approvalId,
            String planSha256,
            String payloadSha256,
            String wireBodySha256,
            DispatchBinding dispatchBinding,
            LocalDate budgetDay,
            String priceVersion,
            long reservedMicroUsd) {}

    public record Gate(
            String installationId,
            long ownerUserId,
            long policyRevision,
            String policySha256,
            long dailyLimitMicroUsd,
            long monthlyLimitMicroUsd,
            boolean reconciliationRequired,
            boolean legacyLiabilityUnresolved,
            long journalSequence,
            String journalHash,
            String journalProjectionSha256,
            long clockHighWaterMs) {}

    public record Request(
            UUID requestId,
            String installationId,
            Long ownerUserId,
            Long projectId,
            Long snapshotId,
            UUID approvalId,
            String planSha256,
            String payloadSha256,
            String wireBodySha256,
            DispatchBinding dispatchBinding,
            LocalDate budgetDay,
            String priceVersion,
            long reservedMicroUsd,
            Status status,
            Long actualMicroUsd,
            String proofSha256,
            long liabilityFloorMicroUsd,
            boolean conflict,
            Long journalSequence,
            String journalHash) {
        public BigInteger liability() {
            return status == Status.SETTLED && !conflict
                    ? BigInteger.valueOf(actualMicroUsd)
                    : BigInteger.valueOf(Math.max(
                            liabilityFloorMicroUsd,
                            Math.max(reservedMicroUsd, actualMicroUsd == null ? 0 : actualMicroUsd)));
        }

        public boolean hasOriginalBinding() {
            return ownerUserId != null
                    && projectId != null
                    && snapshotId != null
                    && approvalId != null
                    && dispatchBinding != null;
        }
    }

    public record UsageDimensions(Map<UsageDimension, Long> units) {
        public UsageDimensions {
            if (units == null) throw error("INVALID_USAGE");
            EnumMap<UsageDimension, Long> copy = new EnumMap<>(UsageDimension.class);
            units.forEach((dimension, value) -> {
                if (dimension == null || value == null || value < 0) throw error("INVALID_USAGE");
                copy.put(dimension, value);
            });
            units = Map.copyOf(copy);
        }
    }

    public record Evidence(
            UUID requestId,
            String proofSha256,
            String mainEpoch,
            ReceiptType receiptType,
            String providerRequestId,
            UsageDimensions usageDimensions,
            long actualMicroUsd) {}

    public record Projection(Gate gate, List<Request> requests, List<Evidence> evidence) {
        public Projection {
            requests = List.copyOf(requests);
            evidence = List.copyOf(evidence);
        }
    }

    public record Position(long sequence, String hash, String projectionSha256, long clockHighWaterMs) {}

    public record FreshEnrollment(String installationId, long ownerUserId, String mainEpoch, String proofSha256) {}

    public record DispatchReceipt(
            String installationId,
            UUID requestId,
            String mainEpoch,
            String payloadSha256,
            LocalDate budgetDay,
            String priceVersion,
            long reservedMicroUsd,
            Position position) {}

    public record MainEvidence(
            String installationId,
            UUID requestId,
            String payloadSha256,
            String priceVersion,
            String proofSha256,
            String mainEpoch,
            ReceiptType receiptType,
            String providerRequestId,
            UsageDimensions usageDimensions,
            long actualMicroUsd) {}

    public record SettlementReceipt(
            String installationId,
            UUID requestId,
            String payloadSha256,
            String proofSha256,
            long actualMicroUsd,
            Position position) {}

    public record JournalObligation(
            UUID requestId,
            String payloadSha256,
            LocalDate budgetDay,
            String priceVersion,
            long reservedMicroUsd,
            Status status,
            Long actualMicroUsd,
            String proofSha256,
            long liabilityFloorMicroUsd,
            boolean conflict) {
        BigInteger liability() {
            return status == Status.SETTLED && !conflict
                    ? BigInteger.valueOf(actualMicroUsd)
                    : BigInteger.valueOf(Math.max(
                            liabilityFloorMicroUsd,
                            Math.max(reservedMicroUsd, actualMicroUsd == null ? 0 : actualMicroUsd)));
        }
    }

    public record JournalView(
            String installationId,
            Position position,
            LocalDate budgetDay,
            boolean restorePending,
            List<JournalObligation> obligations) {
        public JournalView {
            obligations = List.copyOf(obligations);
        }
    }

    /** Implemented only by the authenticated main adapter, never by renderer-supplied claims. */
    public interface MainAuthority {
        default Optional<FreshEnrollment> findFreshEnrollment(String installationId, long ownerUserId) {
            return Optional.empty();
        }

        DispatchReceipt readDispatch(String installationId, UUID requestId);

        MainEvidence readEvidence(String installationId, UUID requestId, String proofSha256);

        SettlementReceipt readSettlement(String installationId, UUID requestId, String proofSha256);

        JournalView readJournal(String installationId);
    }

    private final JdbcClient jdbc;
    private final JsonMapper json;
    private final TransactionTemplate transactions;
    private final TransactionTemplate reads;
    private final Supplier<MainAuthority> authority;
    private final Clock clock;

    @Autowired
    public AiCostLedger(
            JdbcClient jdbc,
            JsonMapper json,
            PlatformTransactionManager manager,
            ObjectProvider<MainAuthority> authority) {
        this(jdbc, json, manager, authority::getIfAvailable, Clock.systemUTC());
    }

    AiCostLedger(
            JdbcClient jdbc,
            JsonMapper json,
            PlatformTransactionManager manager,
            MainAuthority authority,
            Clock clock) {
        this(jdbc, json, manager, () -> authority, clock);
    }

    private AiCostLedger(
            JdbcClient jdbc,
            JsonMapper json,
            PlatformTransactionManager manager,
            Supplier<MainAuthority> authority,
            Clock clock) {
        this.jdbc = jdbc;
        this.json = json;
        this.authority = authority;
        this.clock = clock;
        transactions = new TransactionTemplate(manager);
        transactions.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        reads = new TransactionTemplate(manager);
        reads.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        reads.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        reads.setReadOnly(true);
    }

    public Gate initialize(String installationId, long ownerUserId) {
        installation(installationId);
        positive(ownerUserId);
        MainAuthority main = authority.get();
        Optional<FreshEnrollment> enrollment =
                main == null ? Optional.empty() : main.findFreshEnrollment(installationId, ownerUserId);
        enrollment.ifPresent(e -> {
            if (!installationId.equals(e.installationId()) || ownerUserId != e.ownerUserId())
                throw error("ENROLLMENT_MISMATCH");
            epoch(e.mainEpoch());
            hash(e.proofSha256());
        });
        return transactions.execute(tx -> {
            jdbc.sql("""
                    insert into ai_budget_gate (installation_id, owner_user_id, policy_sha256,
                        journal_hash, journal_projection_sha256, legacy_liability_unresolved)
                    values (:installation, :owner, :policy, :zero, :zero, :legacy)
                    on conflict (installation_id) do nothing
                    """)
                    .param("installation", installationId)
                    .param("owner", ownerUserId)
                    .param("policy", policyHash(installationId, ownerUserId, 0, 0, 0))
                    .param("zero", ZERO)
                    .param("legacy", enrollment.isEmpty())
                    .update();
            Gate gate = lock(installationId);
            owner(gate, ownerUserId);
            // A later enrollment claim can never reset an existing installation's unknown liabilities.
            return gate;
        });
    }

    public Optional<Gate> read(String installationId) {
        installation(installationId);
        return jdbc.sql("select * from ai_budget_gate where installation_id=:installation")
                .param("installation", installationId)
                .query(this::gate)
                .optional();
    }

    public Gate configure(
            String installationId,
            long ownerUserId,
            long expectedRevision,
            long dailyLimitMicroUsd,
            long monthlyLimitMicroUsd) {
        installation(installationId);
        positive(ownerUserId);
        nonnegative(expectedRevision);
        nonnegative(dailyLimitMicroUsd);
        nonnegative(monthlyLimitMicroUsd);
        return transactions.execute(tx -> {
            Gate gate = lock(installationId);
            owner(gate, ownerUserId);
            if (gate.policyRevision() != expectedRevision) throw error("POLICY_CHANGED");
            if (expectedRevision == Long.MAX_VALUE) throw error("REVISION_EXHAUSTED");
            long revision = expectedRevision + 1;
            jdbc.sql("""
                    update ai_budget_gate set policy_revision=:revision, policy_sha256=:hash,
                        daily_limit_micro_usd=:daily, monthly_limit_micro_usd=:monthly,
                        reconciliation_required=true, updated_at=now() where installation_id=:installation
                    """)
                    .param("revision", revision)
                    .param(
                            "hash",
                            policyHash(installationId, ownerUserId, revision, dailyLimitMicroUsd, monthlyLimitMicroUsd))
                    .param("daily", dailyLimitMicroUsd)
                    .param("monthly", monthlyLimitMicroUsd)
                    .param("installation", installationId)
                    .update();
            return lock(installationId);
        });
    }

    public Request reserve(Reservation input) {
        validate(input);
        return transactions.execute(tx -> {
            Gate gate = lock(input.installationId());
            owner(gate, input.ownerUserId());
            if (request(input.installationId(), input.requestId()).isPresent()) throw error("DUPLICATE_REQUEST");
            requireReady(gate);
            DispatchBinding binding = input.dispatchBinding();
            if (binding.policyRevision() != gate.policyRevision()
                    || !binding.policySha256().equals(gate.policySha256())) throw error("POLICY_CHANGED");
            long now = now(gate);
            LocalDate day = day(now);
            if (!day.equals(input.budgetDay())) throw error("BUDGET_DAY_CHANGED");
            if (binding.validUntilEpochMs() <= now) throw error("COST_CONTRACT_EXPIRED");
            List<Request> rows = obligations(input.installationId());
            if (rows.stream()
                            .filter(r -> r.status() == Status.RESERVED || r.status() == Status.DISPATCHED)
                            .count()
                    >= 2) throw error("CONCURRENCY_LIMIT");
            BigInteger held = BigInteger.ZERO, daily = BigInteger.ZERO, monthly = BigInteger.ZERO;
            for (Request row : rows) {
                if (row.conflict()) throw error("RECONCILIATION_REQUIRED");
                if (row.status() == Status.SETTLED) {
                    if (row.budgetDay().equals(day)) daily = daily.add(row.liability());
                    if (sameMonth(row.budgetDay(), day)) monthly = monthly.add(row.liability());
                } else held = held.add(row.liability());
            }
            BigInteger heldWithNew = held.add(BigInteger.valueOf(input.reservedMicroUsd()));
            if (gate.dailyLimitMicroUsd() == 0
                    || gate.monthlyLimitMicroUsd() == 0
                    || daily.add(heldWithNew).compareTo(BigInteger.valueOf(gate.dailyLimitMicroUsd())) > 0
                    || monthly.add(heldWithNew).compareTo(BigInteger.valueOf(gate.monthlyLimitMicroUsd())) > 0)
                throw error("BUDGET_EXCEEDED");
            jdbc.sql("""
                    insert into ai_request_ledger (request_id,installation_id,owner_user_id,project_id,snapshot_id,
                        approval_id,plan_sha256,payload_sha256,wire_body_sha256,dispatch_binding,budget_day,
                        price_version,reserved_micro_usd,status,liability_floor_micro_usd)
                    values (:id,:installation,:owner,:project,:snapshot,:approval,:plan,:payload,:wire,
                        cast(:binding as jsonb),:day,:price,:reserved,'RESERVED',:reserved)
                    """)
                    .param("id", input.requestId())
                    .param("installation", input.installationId())
                    .param("owner", input.ownerUserId())
                    .param("project", input.projectId())
                    .param("snapshot", input.snapshotId())
                    .param("approval", input.approvalId())
                    .param("plan", input.planSha256())
                    .param("payload", input.payloadSha256())
                    .param("wire", input.wireBodySha256())
                    .param("binding", json.writeValueAsString(binding))
                    .param("day", day)
                    .param("price", input.priceVersion())
                    .param("reserved", input.reservedMicroUsd())
                    .update();
            clockWater(input.installationId(), now);
            return requireRequest(input.installationId(), input.requestId());
        });
    }

    /** Private main readback. A restored placeholder can never obtain a dispatch permit. */
    public Request requireDispatchable(String installationId, UUID requestId, String mainEpoch) {
        installation(installationId);
        id(requestId);
        epoch(mainEpoch);
        return transactions.execute(tx -> {
            Gate gate = lock(installationId);
            requireReady(gate);
            Request row = requireRequest(installationId, requestId);
            if (!row.hasOriginalBinding() || row.status() != Status.RESERVED || row.conflict())
                throw error("NOT_DISPATCHABLE");
            owner(gate, row.ownerUserId());
            DispatchBinding binding = row.dispatchBinding();
            if (!binding.mainEpoch().equals(mainEpoch)) throw error("MAIN_EPOCH_CHANGED");
            if (binding.policyRevision() != gate.policyRevision()
                    || !binding.policySha256().equals(gate.policySha256())) throw error("POLICY_CHANGED");
            long now = now(gate);
            if (!row.budgetDay().equals(day(now))) throw error("BUDGET_DAY_CHANGED");
            if (binding.validUntilEpochMs() <= now) throw error("COST_CONTRACT_EXPIRED");
            return row;
        });
    }

    public Request markDispatched(String installationId, UUID requestId) {
        installation(installationId);
        id(requestId);
        DispatchReceipt receipt = main().readDispatch(installationId, requestId);
        if (receipt == null) throw error("DISPATCH_PROOF_REQUIRED");
        position(receipt.position());
        positive(receipt.position().sequence());
        epoch(receipt.mainEpoch());
        return transactions.execute(tx -> {
            Gate gate = lock(installationId);
            Request row = requireRequest(installationId, requestId);
            if (!row.hasOriginalBinding()
                    || !installationId.equals(receipt.installationId())
                    || !requestId.equals(receipt.requestId())
                    || !row.payloadSha256().equals(receipt.payloadSha256())
                    || !row.dispatchBinding().mainEpoch().equals(receipt.mainEpoch())
                    || !row.budgetDay().equals(receipt.budgetDay())
                    || !row.priceVersion().equals(receipt.priceVersion())
                    || row.reservedMicroUsd() != receipt.reservedMicroUsd()) throw error("DISPATCH_PROOF_MISMATCH");
            if (row.status() != Status.RESERVED && row.status() != Status.DISPATCHED) throw error("NOT_DISPATCHABLE");
            if (row.conflict()) throw error("RECONCILIATION_REQUIRED");
            if (row.status() == Status.DISPATCHED) {
                // Reconciliation may have published a newer position after this durable ACK.
                advance(gate, receipt.position());
                return row;
            }
            updateState(row, Status.DISPATCHED, null, null, row.liabilityFloorMicroUsd(), false, receipt.position());
            advance(gate, receipt.position());
            return requireRequest(installationId, requestId);
        });
    }

    /** Persists authenticated main evidence; this method never releases a reservation. */
    public Evidence recordMainEvidence(String installationId, UUID requestId, String proofSha256) {
        installation(installationId);
        id(requestId);
        hash(proofSha256);
        MainEvidence proof = main().readEvidence(installationId, requestId, proofSha256);
        validate(proof);
        return transactions.execute(tx -> {
            lock(installationId);
            Request row = requireRequest(installationId, requestId);
            if (!installationId.equals(proof.installationId())
                    || !requestId.equals(proof.requestId())
                    || !proofSha256.equals(proof.proofSha256())
                    || !row.payloadSha256().equals(proof.payloadSha256())
                    || !row.priceVersion().equals(proof.priceVersion())
                    || !row.hasOriginalBinding()
                    || !row.dispatchBinding().mainEpoch().equals(proof.mainEpoch())) throw error("EVIDENCE_MISMATCH");
            if (proof.receiptType() == ReceiptType.USAGE)
                requireUsage(row.dispatchBinding().operation(), proof.usageDimensions());
            Evidence value = new Evidence(
                    requestId,
                    proofSha256,
                    proof.mainEpoch(),
                    proof.receiptType(),
                    proof.providerRequestId(),
                    proof.usageDimensions(),
                    proof.actualMicroUsd());
            Optional<Evidence> old = evidence(requestId, proofSha256);
            if (old.isPresent()) {
                if (!old.get().equals(value)) throw error("EVIDENCE_MISMATCH");
                return old.get();
            }
            jdbc.sql("""
                    insert into ai_usage_evidence (request_id,proof_sha256,main_epoch,receipt_type,
                        provider_request_id,usage_dimensions,actual_micro_usd)
                    values (:id,:proof,:epoch,:type,:provider,cast(:usage as jsonb),:actual)
                    """)
                    .param("id", requestId)
                    .param("proof", proofSha256)
                    .param("epoch", proof.mainEpoch())
                    .param("type", proof.receiptType().name())
                    .param("provider", proof.providerRequestId(), java.sql.Types.VARCHAR)
                    .param("usage", json.writeValueAsString(proof.usageDimensions()))
                    .param("actual", proof.actualMicroUsd())
                    .update();
            return value;
        });
    }

    public Request confirmJournalSettlement(String installationId, UUID requestId, String proofSha256) {
        installation(installationId);
        id(requestId);
        hash(proofSha256);
        SettlementReceipt receipt = main().readSettlement(installationId, requestId, proofSha256);
        if (receipt == null) throw error("SETTLEMENT_PROOF_REQUIRED");
        position(receipt.position());
        positive(receipt.position().sequence());
        nonnegative(receipt.actualMicroUsd());
        return transactions.execute(tx -> {
            Gate gate = lock(installationId);
            Request row = requireRequest(installationId, requestId);
            Evidence proof = evidence(requestId, proofSha256).orElseThrow(() -> error("EVIDENCE_REQUIRED"));
            if (!installationId.equals(receipt.installationId())
                    || !requestId.equals(receipt.requestId())
                    || !row.payloadSha256().equals(receipt.payloadSha256())
                    || !proofSha256.equals(receipt.proofSha256())
                    || proof.actualMicroUsd() != receipt.actualMicroUsd()) throw error("SETTLEMENT_PROOF_MISMATCH");
            if (row.conflict()) throw error("RECONCILIATION_REQUIRED");
            if (row.status() == Status.SETTLED
                    && (!proofSha256.equals(row.proofSha256()) || row.actualMicroUsd() != receipt.actualMicroUsd()))
                throw error("SETTLEMENT_CONFLICT");
            if (row.status() == Status.SETTLED) {
                // The identical final receipt remains valid after a later full projection readback.
                advance(gate, receipt.position());
                if (receipt.actualMicroUsd() > row.reservedMicroUsd()) block(installationId);
                return row;
            }
            updateState(
                    row,
                    Status.SETTLED,
                    receipt.actualMicroUsd(),
                    proofSha256,
                    row.liabilityFloorMicroUsd(),
                    false,
                    receipt.position());
            advance(gate, receipt.position());
            if (receipt.actualMicroUsd() > row.reservedMicroUsd()) block(installationId);
            return requireRequest(installationId, requestId);
        });
    }

    /** A conservative local transition is safe even if main is unreachable; it is not a main ACK. */
    public Request holdUnknown(String installationId, UUID requestId) {
        installation(installationId);
        id(requestId);
        return transactions.execute(tx -> {
            lock(installationId);
            Request row = requireRequest(installationId, requestId);
            if (row.status() == Status.SETTLED) throw error("ALREADY_SETTLED");
            updateState(row, Status.UNKNOWN_HELD, null, null, row.liabilityFloorMicroUsd(), row.conflict(), null);
            return requireRequest(installationId, requestId);
        });
    }

    public List<Request> readObligations(String installationId) {
        installation(installationId);
        return List.copyOf(obligations(installationId));
    }

    public Optional<Request> readRequest(String installationId, UUID requestId) {
        installation(installationId);
        id(requestId);
        return request(installationId, requestId);
    }

    /** A complete consistent readback, not three unrelated READ COMMITTED snapshots. */
    public Projection projection(String installationId) {
        installation(installationId);
        return reads.execute(tx -> new Projection(
                read(installationId).orElseThrow(() -> error("NOT_INITIALIZED")),
                obligations(installationId),
                jdbc.sql("""
                    select e.* from ai_usage_evidence e join ai_request_ledger r using (request_id)
                    where r.installation_id=:installation order by e.request_id,e.proof_sha256
                    """)
                        .param("installation", installationId)
                        .query(this::evidence)
                        .list()));
    }

    /** Union is conservative. It cannot import PG-only liabilities into B or acknowledge a pending B restore. */
    public Projection reconcile(String installationId) {
        installation(installationId);
        JournalView journal = main().readJournal(installationId);
        validate(journal, installationId);
        transactions.executeWithoutResult(tx -> {
            Gate gate = lock(installationId);
            Position position = journal.position();
            if (position.sequence() < gate.journalSequence()) throw error("JOURNAL_REGRESSION");
            if (position.sequence() == gate.journalSequence()
                    && gate.journalSequence() != 0
                    && (!position.hash().equals(gate.journalHash())
                            || !position.projectionSha256().equals(gate.journalProjectionSha256())))
                throw error("JOURNAL_CONFLICT");
            Map<UUID, Request> existing = new HashMap<>();
            obligations(installationId).forEach(row -> existing.put(row.requestId(), row));
            boolean unresolved = journal.restorePending() || gate.legacyLiabilityUnresolved();
            for (JournalObligation incoming : journal.obligations()) {
                Request row = existing.remove(incoming.requestId());
                if (row == null) insertPlaceholder(installationId, incoming, position);
                else merge(row, incoming, position);
            }
            // A committed reservation can legitimately precede its first journal append.
            if (existing.values().stream().anyMatch(row -> row.status() != Status.RESERVED || row.conflict()))
                unresolved = true;
            for (Request row : obligations(installationId)) {
                if (row.conflict() || (row.status() == Status.SETTLED && row.actualMicroUsd() > row.reservedMicroUsd()))
                    unresolved = true;
            }
            long now = clock.millis();
            if (now < Math.max(position.clockHighWaterMs(), gate.clockHighWaterMs())
                    || journal.budgetDay().isAfter(day(now))) unresolved = true;
            advance(gate, position);
            jdbc.sql("""
                    update ai_budget_gate set reconciliation_required=:blocked, updated_at=now()
                    where installation_id=:installation
                    """)
                    .param("blocked", unresolved)
                    .param("installation", installationId)
                    .update();
        });
        return projection(installationId);
    }

    private void merge(Request row, JournalObligation incoming, Position position) {
        long floor = Math.max(row.liabilityFloorMicroUsd(), incoming.liabilityFloorMicroUsd());
        boolean same = row.payloadSha256().equals(incoming.payloadSha256())
                && row.budgetDay().equals(incoming.budgetDay())
                && row.priceVersion().equals(incoming.priceVersion())
                && row.reservedMicroUsd() == incoming.reservedMicroUsd();
        boolean conflict = row.conflict() || incoming.conflict() || !same;
        if (row.status() == Status.SETTLED
                && (incoming.status() != Status.SETTLED
                        || !row.actualMicroUsd().equals(incoming.actualMicroUsd())
                        || !row.proofSha256().equals(incoming.proofSha256()))) conflict = true;
        if (conflict) {
            floor = Math.max(floor, row.liability().max(incoming.liability()).longValueExact());
            updateState(row, row.status(), row.actualMicroUsd(), row.proofSha256(), floor, true, position);
        } else if (incoming.status() == Status.SETTLED) {
            updateState(row, Status.SETTLED, incoming.actualMicroUsd(), incoming.proofSha256(), floor, false, position);
        } else {
            Status status = row.status() == Status.UNKNOWN_HELD || incoming.status() == Status.UNKNOWN_HELD
                    ? Status.UNKNOWN_HELD
                    : row.status() == Status.DISPATCHED || incoming.status() == Status.DISPATCHED
                            ? Status.DISPATCHED
                            : Status.RESERVED;
            updateState(row, status, null, null, floor, false, position);
        }
    }

    private void insertPlaceholder(String installation, JournalObligation row, Position position) {
        jdbc.sql("""
                insert into ai_request_ledger (request_id,installation_id,plan_sha256,payload_sha256,
                    wire_body_sha256,dispatch_binding,budget_day,price_version,reserved_micro_usd,status,
                    actual_micro_usd,proof_sha256,liability_floor_micro_usd,conflict,journal_sequence,journal_hash)
                values (:id,:installation,:zero,:payload,:zero,'{}',:day,:price,:reserved,:status,:actual,
                    :proof,:floor,:conflict,:sequence,:hash)
                """)
                .param("id", row.requestId())
                .param("installation", installation)
                .param("zero", ZERO)
                .param("payload", row.payloadSha256())
                .param("day", row.budgetDay())
                .param("price", row.priceVersion())
                .param("reserved", row.reservedMicroUsd())
                .param("status", row.status().name())
                .param("actual", row.actualMicroUsd(), java.sql.Types.BIGINT)
                .param("proof", row.proofSha256(), java.sql.Types.VARCHAR)
                .param("floor", row.liabilityFloorMicroUsd())
                .param("conflict", row.conflict())
                .param("sequence", position.sequence())
                .param("hash", position.hash())
                .update();
    }

    private void updateState(
            Request row, Status status, Long actual, String proof, long floor, boolean conflict, Position position) {
        if (position != null && row.journalSequence() != null && position.sequence() < row.journalSequence())
            throw error("JOURNAL_REGRESSION");
        jdbc.sql("""
                update ai_request_ledger set status=:status,actual_micro_usd=:actual,proof_sha256=:proof,
                    liability_floor_micro_usd=:floor,conflict=:conflict,journal_sequence=:sequence,
                    journal_hash=:hash,updated_at=now() where request_id=:id and installation_id=:installation
                """)
                .param("status", status.name())
                .param("actual", actual, java.sql.Types.BIGINT)
                .param("proof", proof, java.sql.Types.VARCHAR)
                .param("floor", floor)
                .param("conflict", conflict)
                .param(
                        "sequence",
                        position == null ? row.journalSequence() : Long.valueOf(position.sequence()),
                        java.sql.Types.BIGINT)
                .param("hash", position == null ? row.journalHash() : position.hash(), java.sql.Types.VARCHAR)
                .param("id", row.requestId())
                .param("installation", row.installationId())
                .update();
    }

    private void advance(Gate gate, Position position) {
        if (position.sequence() == gate.journalSequence()
                && gate.journalSequence() != 0
                && (!position.hash().equals(gate.journalHash())
                        || !position.projectionSha256().equals(gate.journalProjectionSha256())))
            throw error("JOURNAL_CONFLICT");
        if (position.sequence() >= gate.journalSequence()) {
            jdbc.sql("""
                    update ai_budget_gate set journal_sequence=:sequence,journal_hash=:hash,
                        journal_projection_sha256=:projection,clock_high_water_ms=greatest(clock_high_water_ms,:clock),
                        updated_at=now() where installation_id=:installation
                    """)
                    .param("sequence", position.sequence())
                    .param("hash", position.hash())
                    .param("projection", position.projectionSha256())
                    .param("clock", position.clockHighWaterMs())
                    .param("installation", gate.installationId())
                    .update();
        }
    }

    private void clockWater(String installation, long now) {
        jdbc.sql(
                        "update ai_budget_gate set clock_high_water_ms=greatest(clock_high_water_ms,:now), updated_at=now() where installation_id=:installation")
                .param("now", now)
                .param("installation", installation)
                .update();
    }

    private void block(String installation) {
        jdbc.sql(
                        "update ai_budget_gate set reconciliation_required=true,updated_at=now() where installation_id=:installation")
                .param("installation", installation)
                .update();
    }

    private Gate lock(String installation) {
        return jdbc.sql("select * from ai_budget_gate where installation_id=:installation for update")
                .param("installation", installation)
                .query(this::gate)
                .optional()
                .orElseThrow(() -> error("NOT_INITIALIZED"));
    }

    private Optional<Request> request(String installation, UUID id) {
        return jdbc.sql("select * from ai_request_ledger where installation_id=:installation and request_id=:id")
                .param("installation", installation)
                .param("id", id)
                .query(this::request)
                .optional();
    }

    private Request requireRequest(String installation, UUID id) {
        return request(installation, id).orElseThrow(() -> error("UNKNOWN_REQUEST"));
    }

    private List<Request> obligations(String installation) {
        return jdbc.sql("select * from ai_request_ledger where installation_id=:installation order by request_id")
                .param("installation", installation)
                .query(this::request)
                .list();
    }

    private Optional<Evidence> evidence(UUID id, String proof) {
        return jdbc.sql("select * from ai_usage_evidence where request_id=:id and proof_sha256=:proof")
                .param("id", id)
                .param("proof", proof)
                .query(this::evidence)
                .optional();
    }

    private Gate gate(ResultSet rs, int index) throws SQLException {
        return new Gate(
                rs.getString("installation_id"),
                rs.getLong("owner_user_id"),
                rs.getLong("policy_revision"),
                rs.getString("policy_sha256"),
                rs.getLong("daily_limit_micro_usd"),
                rs.getLong("monthly_limit_micro_usd"),
                rs.getBoolean("reconciliation_required"),
                rs.getBoolean("legacy_liability_unresolved"),
                rs.getLong("journal_sequence"),
                rs.getString("journal_hash"),
                rs.getString("journal_projection_sha256"),
                rs.getLong("clock_high_water_ms"));
    }

    private Request request(ResultSet rs, int index) throws SQLException {
        String serialized = rs.getString("dispatch_binding");
        Map<?, ?> fields = json.readValue(serialized, Map.class);
        DispatchBinding binding = null;
        if (!fields.isEmpty()) {
            if (!fields.keySet().equals(BINDING_FIELDS)) throw error("INVALID_BINDING");
            binding = json.readValue(serialized, DispatchBinding.class);
            validate(binding);
        }
        return new Request(
                rs.getObject("request_id", UUID.class),
                rs.getString("installation_id"),
                rs.getObject("owner_user_id", Long.class),
                rs.getObject("project_id", Long.class),
                rs.getObject("snapshot_id", Long.class),
                rs.getObject("approval_id", UUID.class),
                rs.getString("plan_sha256"),
                rs.getString("payload_sha256"),
                rs.getString("wire_body_sha256"),
                binding,
                rs.getObject("budget_day", LocalDate.class),
                rs.getString("price_version"),
                rs.getLong("reserved_micro_usd"),
                Status.valueOf(rs.getString("status")),
                rs.getObject("actual_micro_usd", Long.class),
                rs.getString("proof_sha256"),
                rs.getLong("liability_floor_micro_usd"),
                rs.getBoolean("conflict"),
                rs.getObject("journal_sequence", Long.class),
                rs.getString("journal_hash"));
    }

    private Evidence evidence(ResultSet rs, int index) throws SQLException {
        return new Evidence(
                rs.getObject("request_id", UUID.class),
                rs.getString("proof_sha256"),
                rs.getString("main_epoch"),
                ReceiptType.valueOf(rs.getString("receipt_type")),
                rs.getString("provider_request_id"),
                json.readValue(rs.getString("usage_dimensions"), UsageDimensions.class),
                rs.getLong("actual_micro_usd"));
    }

    private MainAuthority main() {
        MainAuthority result = authority.get();
        if (result == null) throw error("MAIN_UNAVAILABLE");
        return result;
    }

    private long now(Gate gate) {
        long now = clock.millis();
        if (now < 0 || now < gate.clockHighWaterMs()) throw error("CLOCK_REGRESSION");
        return now;
    }

    private static void requireReady(Gate gate) {
        if (gate.legacyLiabilityUnresolved()) throw error("LEGACY_LIABILITY_UNRESOLVED");
        if (gate.reconciliationRequired()) throw error("RECONCILIATION_REQUIRED");
    }

    private static void owner(Gate gate, long owner) {
        if (owner != gate.ownerUserId()) throw error("OWNER_MISMATCH");
    }

    private static LocalDate day(long millis) {
        return java.time.Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate();
    }

    private static boolean sameMonth(LocalDate a, LocalDate b) {
        return a.getYear() == b.getYear() && a.getMonth() == b.getMonth();
    }

    private static String policyHash(String installation, long owner, long revision, long daily, long monthly) {
        return sha256(
                "AI_BUDGET_POLICY_1\n" + installation + "\n" + owner + "\n" + revision + "\n" + daily + "\n" + monthly);
    }

    private static String sha256(String text) {
        try {
            return HexFormat.of()
                    .formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static void validate(Reservation r) {
        if (r == null) throw error("INVALID_INPUT");
        id(r.requestId());
        installation(r.installationId());
        positive(r.ownerUserId());
        positive(r.projectId());
        positive(r.snapshotId());
        id(r.approvalId());
        hash(r.planSha256());
        hash(r.payloadSha256());
        hash(r.wireBodySha256());
        validate(r.dispatchBinding());
        date(r.budgetDay());
        identifier(r.priceVersion());
        nonnegative(r.reservedMicroUsd());
    }

    private static void validate(DispatchBinding b) {
        if (b == null || b.operation() == null) throw error("INVALID_BINDING");
        epoch(b.mainEpoch());
        identifier(b.provider());
        identifier(b.model());
        identifier(b.endpointId());
        identifier(b.adapterVersion());
        identifier(b.tokenizerId());
        identifier(b.tokenizerVersion());
        hash(b.costContractSha256());
        hash(b.priceSha256());
        nonnegative(b.settingsRevision());
        nonnegative(b.policyRevision());
        hash(b.policySha256());
        nonnegative(b.inputTokenUpperBound());
        nonnegative(b.outputTokenMax());
        nonnegative(b.embeddingInputTokenUpperBound());
        nonnegative(b.wireBodyBytes());
        positive(b.validUntilEpochMs());
        if (b.operation() == Operation.CHAT && b.outputTokenMax() == 0) throw error("OUTPUT_CAP_REQUIRED");
        if (b.operation() != Operation.CHAT && b.outputTokenMax() != 0) throw error("INVALID_BINDING");
    }

    private static void validate(MainEvidence e) {
        if (e == null) throw error("EVIDENCE_REQUIRED");
        installation(e.installationId());
        id(e.requestId());
        hash(e.payloadSha256());
        identifier(e.priceVersion());
        hash(e.proofSha256());
        epoch(e.mainEpoch());
        nonnegative(e.actualMicroUsd());
        if (e.receiptType() == null || e.usageDimensions() == null) throw error("INVALID_USAGE");
        if (e.providerRequestId() != null) identifier(e.providerRequestId());
        if (e.receiptType() == ReceiptType.PROVEN_NOT_SENT
                && (e.actualMicroUsd() != 0 || !e.usageDimensions().units().isEmpty() || e.providerRequestId() != null))
            throw error("INVALID_NOT_SENT_PROOF");
    }

    private static void requireUsage(Operation operation, UsageDimensions usage) {
        Set<UsageDimension> required =
                switch (operation) {
                    case CHAT -> Set.of(UsageDimension.INPUT_TOKENS, UsageDimension.OUTPUT_TOKENS);
                    case EMBEDDING -> Set.of(UsageDimension.EMBEDDING_INPUT_TOKENS);
                    case CONNECTION_PROBE -> Set.of(UsageDimension.REQUESTS);
                };
        if (!usage.units().keySet().containsAll(required)) throw error("USAGE_MISSING");
    }

    private static void validate(JournalView view, String installation) {
        if (view == null || !installation.equals(view.installationId())) throw error("JOURNAL_MISMATCH");
        position(view.position());
        date(view.budgetDay());
        Set<UUID> seen = new HashSet<>();
        for (JournalObligation row : view.obligations()) {
            if (row == null) throw error("INVALID_JOURNAL");
            id(row.requestId());
            hash(row.payloadSha256());
            date(row.budgetDay());
            identifier(row.priceVersion());
            nonnegative(row.reservedMicroUsd());
            nonnegative(row.liabilityFloorMicroUsd());
            if (!seen.add(row.requestId())
                    || row.status() == null
                    || row.budgetDay().isAfter(view.budgetDay())) throw error("INVALID_JOURNAL");
            if (row.status() == Status.SETTLED) {
                if (row.actualMicroUsd() == null) throw error("INVALID_JOURNAL");
                nonnegative(row.actualMicroUsd());
                hash(row.proofSha256());
            } else if (row.actualMicroUsd() != null || row.proofSha256() != null) throw error("INVALID_JOURNAL");
        }
    }

    private static void position(Position position) {
        if (position == null) throw error("JOURNAL_PROOF_REQUIRED");
        nonnegative(position.sequence());
        hash(position.hash());
        hash(position.projectionSha256());
        nonnegative(position.clockHighWaterMs());
    }

    private static void installation(String value) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")) throw error("INVALID_INSTALLATION");
    }

    private static void identifier(String value) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) throw error("INVALID_IDENTIFIER");
    }

    private static void hash(String value) {
        if (value == null || !value.matches("[0-9a-f]{64}")) throw error("INVALID_HASH");
    }

    private static void epoch(String value) {
        try {
            if (value == null || !UUID.fromString(value).toString().equals(value)) throw error("INVALID_MAIN_EPOCH");
        } catch (IllegalArgumentException e) {
            throw error("INVALID_MAIN_EPOCH");
        }
    }

    private static void id(UUID value) {
        if (value == null) throw error("INVALID_ID");
    }

    private static void positive(long value) {
        if (value <= 0) throw error("INVALID_NUMBER");
    }

    private static void nonnegative(long value) {
        if (value < 0) throw error("INVALID_NUMBER");
    }

    private static void date(LocalDate value) {
        if (value == null || value.getYear() < 1970 || value.getYear() > 9999) throw error("INVALID_DATE");
    }

    private static AiCostLedgerException error(String code) {
        return new AiCostLedgerException(code);
    }
}
