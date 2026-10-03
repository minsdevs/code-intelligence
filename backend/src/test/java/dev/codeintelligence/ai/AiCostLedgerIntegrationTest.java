package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.codeintelligence.TestcontainersConfiguration;
import java.math.BigInteger;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.UnaryOperator;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

/** Real PostgreSQL locks and immutable rows, with an in-memory authenticated-main test double. */
@SpringBootTest(
        properties = {
            "app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            "app.ts-analyzer.base-url=",
            "app.tree-analyzer.base-url=",
            "app.ai.provider=none",
            "app.ai.openai.api-key=",
            "app.ai.gemini.api-key=",
            "app.github.base-url=http://127.0.0.1:1"
        })
@Import(TestcontainersConfiguration.class)
@Timeout(20)
class AiCostLedgerIntegrationTest {
    private static final String HASH = "a".repeat(64);
    private static final String OTHER_HASH = "b".repeat(64);
    private static final long OWNER = 900_000_001;
    private static final long DAY_MS = 86_400_000;

    @TempDir
    static Path root;

    @Autowired
    JdbcClient jdbc;

    @Autowired
    JdbcTemplate sql;

    @Autowired
    JsonMapper json;

    @Autowired
    PlatformTransactionManager manager;

    private MutableClock clock;
    private MainFixture main;
    private AiCostLedger ledger;
    private String installation;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", () -> root.resolve("data").toString());
    }

    @BeforeEach
    void fixture() {
        clock = new MutableClock(Instant.parse("2026-10-03T12:00:00Z").toEpochMilli());
        main = new MainFixture(clock);
        ledger = new AiCostLedger(jdbc, json, manager, main, clock);
        installation = "cost-fixture-" + UUID.randomUUID();
    }

    @Test
    void unknownEnrollmentDefaultsToZeroAndCannotActivate() {
        main.fresh = false;
        var gate = ledger.initialize(installation, OWNER);
        assertThat(gate.dailyLimitMicroUsd()).isZero();
        assertThat(gate.monthlyLimitMicroUsd()).isZero();
        assertThat(gate.reconciliationRequired()).isTrue();
        assertThat(gate.legacyLiabilityUnresolved()).isTrue();
        assertThat(ledger.reconcile(installation).gate().reconciliationRequired())
                .isTrue();
    }

    @Test
    void absentMainCannotInventFreshEnrollment() {
        ledger = new AiCostLedger(jdbc, json, manager, (AiCostLedger.MainAuthority) null, clock);
        assertThat(ledger.initialize(installation, OWNER).legacyLiabilityUnresolved())
                .isTrue();
        rejected(() -> ledger.reconcile(installation), "MAIN_UNAVAILABLE");
    }

    @Test
    void authenticatedFreshEnrollmentStillRequiresReconciliationAndBudget() {
        var gate = ledger.initialize(installation, OWNER);
        assertThat(gate.legacyLiabilityUnresolved()).isFalse();
        assertThat(gate.reconciliationRequired()).isTrue();
        rejected(() -> ledger.reserve(reservation(1)), "RECONCILIATION_REQUIRED");
        ledger.reconcile(installation);
        rejected(() -> ledger.reserve(reservation(0)), "BUDGET_EXCEEDED");
    }

    @Test
    void aLaterFreshClaimCannotResetLegacyLiability() {
        main.fresh = false;
        ledger.initialize(installation, OWNER);
        main.fresh = true;
        assertThat(ledger.initialize(installation, OWNER).legacyLiabilityUnresolved())
                .isTrue();
        ledger.configure(installation, OWNER, 0, 100, 100);
        ledger.reconcile(installation);
        rejected(() -> ledger.reserve(reservation(1)), "LEGACY_LIABILITY_UNRESOLVED");
    }

    @Test
    void existingInstallationCannotChangeItsOwner() {
        ledger.initialize(installation, OWNER);
        rejected(() -> ledger.initialize(installation, OWNER + 1), "OWNER_MISMATCH");
        rejected(() -> ledger.configure(installation, OWNER + 1, 0, 100, 100), "OWNER_MISMATCH");
    }

    @Test
    void configureUsesCompareAndSwapAndBlocksUntilReconciled() {
        active(100, 200);
        var before = ledger.read(installation).orElseThrow();
        var after = ledger.configure(installation, OWNER, before.policyRevision(), 200, 300);
        assertThat(after.policyRevision()).isEqualTo(before.policyRevision() + 1);
        assertThat(after.policySha256()).isNotEqualTo(before.policySha256());
        assertThat(after.reconciliationRequired()).isTrue();
        rejected(() -> ledger.configure(installation, OWNER, before.policyRevision(), 1000, 1000), "POLICY_CHANGED");
        rejected(() -> ledger.reserve(reservation(1)), "RECONCILIATION_REQUIRED");
        assertThat(ledger.read(installation).orElseThrow().dailyLimitMicroUsd()).isEqualTo(200);
    }

    @Test
    void exactDailyAndMonthlyReservationIsAllowed() {
        active(100, 100);
        var row = ledger.reserve(reservation(100));
        assertThat(row.status()).isEqualTo(AiCostLedger.Status.RESERVED);
        assertThat(row.actualMicroUsd()).isNull();
        assertThat(row.proofSha256()).isNull();
        assertThat(row.liability()).isEqualTo(BigInteger.valueOf(100));
    }

    @ParameterizedTest
    @ValueSource(strings = {"daily", "monthly"})
    void oneMicroUsdAboveEitherLimitIsRejectedWithoutWriting(String limit) {
        active(limit.equals("daily") ? 100 : 1000, limit.equals("monthly") ? 100 : 1000);
        rejected(() -> ledger.reserve(reservation(101)), "BUDGET_EXCEEDED");
        assertThat(ledger.readObligations(installation)).isEmpty();
    }

    @Test
    void allOldHeldStillConsumesTodaysAndThisMonthsBudget() {
        clock.value = Instant.parse("2026-09-30T12:00:00Z").toEpochMilli();
        active(100, 100);
        var old = ledger.reserve(reservation(80));
        ledger.holdUnknown(installation, old.requestId());
        clock.value = Instant.parse("2026-10-03T12:00:00Z").toEpochMilli();
        rejected(() -> ledger.reserve(reservation(21)), "BUDGET_EXCEEDED");
        assertThat(ledger.reserve(reservation(20)).reservedMicroUsd()).isEqualTo(20);
    }

    @Test
    void yesterdaysSettlementStillConsumesTheMonthlyBudget() {
        active(1000, 100);
        var row = ledger.reserve(reservation(80));
        settle(row, 80);
        clock.value += DAY_MS;
        rejected(() -> ledger.reserve(reservation(21)), "BUDGET_EXCEEDED");
        assertThat(ledger.reserve(reservation(20)).reservedMicroUsd()).isEqualTo(20);
    }

    @Test
    void confirmedSettlementFromPreviousMonthDoesNotCreateAHeldBalance() {
        clock.value = Instant.parse("2026-09-30T12:00:00Z").toEpochMilli();
        active(100, 100);
        settle(ledger.reserve(reservation(100)), 100);
        clock.value += DAY_MS;
        assertThat(ledger.reserve(reservation(100)).reservedMicroUsd()).isEqualTo(100);
    }

    @Test
    void sameDaySettlementIsCountedExactlyOnce() {
        active(100, 100);
        settle(ledger.reserve(reservation(90)), 30);
        assertThat(ledger.reserve(reservation(70)).reservedMicroUsd()).isEqualTo(70);
        rejected(() -> ledger.reserve(reservation(1)), "BUDGET_EXCEEDED");
    }

    @Test
    void sumCannotOverflowSigned64BitAndMintBudget() {
        active(Long.MAX_VALUE, Long.MAX_VALUE);
        long amount = 1L << 62;
        ledger.reserve(reservation(amount));
        rejected(() -> ledger.reserve(reservation(amount)), "BUDGET_EXCEEDED");
        assertThat(ledger.readObligations(installation)).hasSize(1);
    }

    @Test
    void twoParallelReservationsCannotBothSpendTheSameRemainingBudget() throws Exception {
        active(100, 100);
        var first = reservation(60);
        var second = reservation(60);
        var results = parallel(List.of(first, second));
        assertThat(results).containsExactlyInAnyOrder("OK", "BUDGET_EXCEEDED");
        assertThat(ledger.readObligations(installation)).hasSize(1);
    }

    @Test
    void onlyTwoConcurrentRequestsMayBeReserved() throws Exception {
        active(1000, 1000);
        var results = parallel(List.of(reservation(1), reservation(1), reservation(1)));
        assertThat(results).containsExactlyInAnyOrder("OK", "OK", "CONCURRENCY_LIMIT");
    }

    @Test
    void unknownHeldReleasesConcurrencyButNeverMoney() {
        active(100, 100);
        var first = ledger.reserve(reservation(40));
        ledger.reserve(reservation(40));
        ledger.holdUnknown(installation, first.requestId());
        rejected(() -> ledger.reserve(reservation(21)), "BUDGET_EXCEEDED");
        ledger.reserve(reservation(20));
    }

    @Test
    void sameUuidCannotReserveTwiceEvenWithAnIdenticalBinding() {
        active(100, 100);
        var request = reservation(10);
        ledger.reserve(request);
        rejected(() -> ledger.reserve(request), "DUPLICATE_REQUEST");
        assertThat(ledger.readObligations(installation)).hasSize(1);
    }

    @Test
    void changedPayloadCannotReuseAnExistingUuid() {
        active(100, 100);
        var request = reservation(10);
        ledger.reserve(request);
        var altered = new AiCostLedger.Reservation(
                request.requestId(),
                installation,
                OWNER,
                11,
                12,
                request.approvalId(),
                HASH,
                OTHER_HASH,
                HASH,
                request.dispatchBinding(),
                request.budgetDay(),
                "fixture-1",
                10);
        rejected(() -> ledger.reserve(altered), "DUPLICATE_REQUEST");
        assertThat(ledger.readRequest(installation, request.requestId())
                        .orElseThrow()
                        .payloadSha256())
                .isEqualTo(HASH);
    }

    @Test
    void committedReservationSurvivesCallerTransactionRollback() {
        active(100, 100);
        var input = reservation(50);
        assertThatThrownBy(() -> new TransactionTemplate(manager).executeWithoutResult(tx -> {
                    ledger.reserve(input);
                    throw new IllegalStateException("synthetic answer transaction failure");
                }))
                .isInstanceOf(IllegalStateException.class);
        assertThat(ledger.readRequest(installation, input.requestId())).isPresent();
    }

    @Test
    void stalePolicyBindingCannotBeReservedAfterAChange() {
        active(100, 100);
        var old = reservation(10);
        var gate = ledger.read(installation).orElseThrow();
        ledger.configure(installation, OWNER, gate.policyRevision(), 200, 200);
        ledger.reconcile(installation);
        rejected(() -> ledger.reserve(old), "POLICY_CHANGED");
    }

    @Test
    void clockRegressionDoesNotGrantNewBudget() {
        active(100, 100);
        ledger.reserve(reservation(10));
        clock.value--;
        rejected(() -> ledger.reserve(reservation(10)), "CLOCK_REGRESSION");
    }

    @Test
    void expiredCostContractCannotReserve() {
        active(100, 100);
        var request = reservation(10);
        clock.value += 600_000;
        rejected(() -> ledger.reserve(request), "COST_CONTRACT_EXPIRED");
    }

    @Test
    void aPreviousUtcDaysApprovalCannotDispatchAfterMidnight() {
        active(100, 100);
        var row = ledger.reserve(reservation(10));
        clock.value += DAY_MS;
        rejected(() -> ledger.requireDispatchable(installation, row.requestId(), main.epoch), "BUDGET_DAY_CHANGED");
    }

    @Test
    void previousMainEpochCannotObtainADispatch() {
        active(100, 100);
        var row = ledger.reserve(reservation(10));
        rejected(
                () -> ledger.requireDispatchable(
                        installation, row.requestId(), UUID.randomUUID().toString()),
                "MAIN_EPOCH_CHANGED");
    }

    @Test
    void dispatchRequiresMatchingMainDurableEvidence() {
        active(100, 100);
        var row = ledger.reserve(reservation(10));
        rejected(() -> ledger.markDispatched(installation, row.requestId()), "DISPATCH_PROOF_REQUIRED");
        main.dispatch(row);
        assertThat(ledger.markDispatched(installation, row.requestId()).status())
                .isEqualTo(AiCostLedger.Status.DISPATCHED);
        assertThat(ledger.markDispatched(installation, row.requestId()).status())
                .isEqualTo(AiCostLedger.Status.DISPATCHED);
        rejected(() -> ledger.requireDispatchable(installation, row.requestId(), main.epoch), "NOT_DISPATCHABLE");
    }

    @Test
    void changedDispatchProofRollsBackWithoutPublishingItsSequence() {
        active(100, 100);
        var row = ledger.reserve(reservation(10));
        main.dispatch(row);
        var r = main.dispatches.get(row.requestId());
        main.dispatches.put(
                row.requestId(),
                new AiCostLedger.DispatchReceipt(
                        installation,
                        row.requestId(),
                        main.epoch,
                        OTHER_HASH,
                        r.budgetDay(),
                        r.priceVersion(),
                        r.reservedMicroUsd(),
                        r.position()));
        rejected(() -> ledger.markDispatched(installation, row.requestId()), "DISPATCH_PROOF_MISMATCH");
        assertThat(ledger.readRequest(installation, row.requestId())
                        .orElseThrow()
                        .status())
                .isEqualTo(AiCostLedger.Status.RESERVED);
        assertThat(ledger.read(installation).orElseThrow().journalSequence()).isEqualTo(1);
    }

    @Test
    void identicalDispatchAckCanBeRetriedAfterANewerReconciliation() {
        active(100, 100);
        var row = ledger.reserve(reservation(10));
        main.dispatch(row);
        ledger.markDispatched(installation, row.requestId());
        long originalSequence = main.dispatches.get(row.requestId()).position().sequence();
        main.bump();
        ledger.reconcile(installation);
        var retried = ledger.markDispatched(installation, row.requestId());
        assertThat(retried.status()).isEqualTo(AiCostLedger.Status.DISPATCHED);
        assertThat(retried.journalSequence()).isGreaterThan(originalSequence);
        assertThat(ledger.read(installation).orElseThrow().journalSequence()).isEqualTo(main.sequence);
    }

    @Test
    void recordingKnownUsageAloneDoesNotReleaseAnyReservation() {
        active(100, 100);
        var row = ledger.reserve(reservation(100));
        main.usage(row, 10, usage(1, 1));
        ledger.recordMainEvidence(installation, row.requestId(), HASH);
        var current = ledger.readRequest(installation, row.requestId()).orElseThrow();
        assertThat(current.actualMicroUsd()).isNull();
        assertThat(current.liability()).isEqualTo(BigInteger.valueOf(100));
        rejected(() -> ledger.reserve(reservation(1)), "BUDGET_EXCEEDED");
    }

    @Test
    void duplicateEvidenceIsIdempotentButChangedEvidenceIsRejected() {
        active(100, 100);
        var row = ledger.reserve(reservation(100));
        main.usage(row, 10, usage(1, 1));
        var before = ledger.recordMainEvidence(installation, row.requestId(), HASH);
        assertThat(ledger.recordMainEvidence(installation, row.requestId(), HASH))
                .isEqualTo(before);
        main.usage(row, 11, usage(1, 1));
        rejected(() -> ledger.recordMainEvidence(installation, row.requestId(), HASH), "EVIDENCE_MISMATCH");
        assertThat(ledger.projection(installation).evidence()).containsExactly(before);
    }

    @ParameterizedTest
    @ValueSource(strings = {"payload", "epoch", "price", "installation"})
    void mainEvidenceMustMatchTheOriginalBinding(String field) {
        active(100, 100);
        var row = ledger.reserve(reservation(100));
        main.usage(row, 10, usage(1, 1));
        var proof = main.evidence.get(row.requestId());
        main.evidence.put(
                row.requestId(),
                new AiCostLedger.MainEvidence(
                        field.equals("installation") ? "other-installation" : installation,
                        row.requestId(),
                        field.equals("payload") ? OTHER_HASH : HASH,
                        field.equals("price") ? "other-price" : "fixture-1",
                        HASH,
                        field.equals("epoch") ? UUID.randomUUID().toString() : main.epoch,
                        proof.receiptType(),
                        proof.providerRequestId(),
                        proof.usageDimensions(),
                        proof.actualMicroUsd()));
        rejected(() -> ledger.recordMainEvidence(installation, row.requestId(), HASH), "EVIDENCE_MISMATCH");
        assertThat(ledger.projection(installation).evidence()).isEmpty();
    }

    @Test
    void explicitZeroUsageIsKnownAndReleasesOnlyAfterJournalSettlement() {
        active(100, 100);
        var row = ledger.reserve(reservation(100));
        main.usage(row, 0, usage(0, 0));
        ledger.recordMainEvidence(installation, row.requestId(), HASH);
        assertThat(ledger.readRequest(installation, row.requestId())
                        .orElseThrow()
                        .actualMicroUsd())
                .isNull();
        main.settlement(row, 0);
        var settled = ledger.confirmJournalSettlement(installation, row.requestId(), HASH);
        assertThat(settled.actualMicroUsd()).isZero();
        assertThat(ledger.reserve(reservation(100)).reservedMicroUsd()).isEqualTo(100);
    }

    @ParameterizedTest
    @ValueSource(strings = {"all", "output", "input"})
    void missingUsageIsNotImplicitZero(String missing) {
        active(100, 100);
        var row = ledger.reserve(reservation(100));
        Map<AiCostLedger.UsageDimension, Long> counts = new LinkedHashMap<>();
        if (!missing.equals("all") && !missing.equals("input"))
            counts.put(AiCostLedger.UsageDimension.INPUT_TOKENS, 0L);
        if (!missing.equals("all") && !missing.equals("output"))
            counts.put(AiCostLedger.UsageDimension.OUTPUT_TOKENS, 0L);
        main.usage(row, 0, new AiCostLedger.UsageDimensions(counts));
        rejected(() -> ledger.recordMainEvidence(installation, row.requestId(), HASH), "USAGE_MISSING");
        assertThat(ledger.holdUnknown(installation, row.requestId()).liability())
                .isEqualTo(BigInteger.valueOf(100));
    }

    @Test
    void embeddingRequiresEmbeddingUsageAndRetainsItsReservationUntilSettled() {
        active(100, 100);
        var row = ledger.reserve(withBinding(
                reservation(100), b -> binding(b, AiCostLedger.Operation.EMBEDDING, 0, "fixture-endpoint")));
        main.usage(row, 0, usage(0, 0));
        rejected(() -> ledger.recordMainEvidence(installation, row.requestId(), HASH), "USAGE_MISSING");
        main.usage(
                row,
                10,
                new AiCostLedger.UsageDimensions(Map.of(AiCostLedger.UsageDimension.EMBEDDING_INPUT_TOKENS, 2L)));
        ledger.recordMainEvidence(installation, row.requestId(), HASH);
        assertThat(ledger.readRequest(installation, row.requestId())
                        .orElseThrow()
                        .liability())
                .isEqualTo(BigInteger.valueOf(100));
        main.settlement(row, 10);
        assertThat(ledger.confirmJournalSettlement(installation, row.requestId(), HASH)
                        .actualMicroUsd())
                .isEqualTo(10);
    }

    @Test
    void nullAndNegativeUsageDimensionsAreRejected() {
        Map<AiCostLedger.UsageDimension, Long> counts = new LinkedHashMap<>();
        counts.put(AiCostLedger.UsageDimension.INPUT_TOKENS, null);
        rejected(() -> new AiCostLedger.UsageDimensions(counts), "INVALID_USAGE");
        rejected(
                () -> new AiCostLedger.UsageDimensions(Map.of(AiCostLedger.UsageDimension.INPUT_TOKENS, -1L)),
                "INVALID_USAGE");
    }

    @Test
    void provenNotSentRequiresMainEvidenceAndZeroCost() {
        active(100, 100);
        var row = ledger.reserve(reservation(100));
        main.evidence.put(
                row.requestId(),
                new AiCostLedger.MainEvidence(
                        installation,
                        row.requestId(),
                        HASH,
                        "fixture-1",
                        HASH,
                        main.epoch,
                        AiCostLedger.ReceiptType.PROVEN_NOT_SENT,
                        null,
                        new AiCostLedger.UsageDimensions(Map.of()),
                        1));
        rejected(() -> ledger.recordMainEvidence(installation, row.requestId(), HASH), "INVALID_NOT_SENT_PROOF");
        main.evidence.put(
                row.requestId(),
                new AiCostLedger.MainEvidence(
                        installation,
                        row.requestId(),
                        HASH,
                        "fixture-1",
                        HASH,
                        main.epoch,
                        AiCostLedger.ReceiptType.PROVEN_NOT_SENT,
                        null,
                        new AiCostLedger.UsageDimensions(Map.of()),
                        0));
        ledger.recordMainEvidence(installation, row.requestId(), HASH);
        main.settlement(row, 0);
        assertThat(ledger.confirmJournalSettlement(installation, row.requestId(), HASH)
                        .actualMicroUsd())
                .isZero();
    }

    @Test
    void journalAckWithoutImmutablePgEvidenceCannotSettle() {
        active(100, 100);
        var row = ledger.reserve(reservation(100));
        main.settlement(row, 0);
        rejected(() -> ledger.confirmJournalSettlement(installation, row.requestId(), HASH), "EVIDENCE_REQUIRED");
        assertThat(ledger.readRequest(installation, row.requestId())
                        .orElseThrow()
                        .actualMicroUsd())
                .isNull();
    }

    @Test
    void evidenceWithoutJournalAckCannotSettle() {
        active(100, 100);
        var row = ledger.reserve(reservation(100));
        main.usage(row, 10, usage(1, 1));
        ledger.recordMainEvidence(installation, row.requestId(), HASH);
        rejected(
                () -> ledger.confirmJournalSettlement(installation, row.requestId(), HASH),
                "SETTLEMENT_PROOF_REQUIRED");
        assertThat(ledger.holdUnknown(installation, row.requestId()).actualMicroUsd())
                .isNull();
    }

    @Test
    void mismatchedJournalAmountCannotReleaseAHold() {
        active(100, 100);
        var row = ledger.reserve(reservation(100));
        main.usage(row, 20, usage(1, 1));
        ledger.recordMainEvidence(installation, row.requestId(), HASH);
        main.settlement(row, 10);
        rejected(
                () -> ledger.confirmJournalSettlement(installation, row.requestId(), HASH),
                "SETTLEMENT_PROOF_MISMATCH");
        assertThat(ledger.readRequest(installation, row.requestId())
                        .orElseThrow()
                        .liability())
                .isEqualTo(BigInteger.valueOf(100));
    }

    @Test
    void confirmedSettlementSurvivesAnswerTransactionFailureAndIsIdempotent() {
        active(100, 100);
        var row = ledger.reserve(reservation(100));
        main.usage(row, 20, usage(1, 1));
        ledger.recordMainEvidence(installation, row.requestId(), HASH);
        main.settlement(row, 20);
        assertThatThrownBy(() -> new TransactionTemplate(manager).executeWithoutResult(tx -> {
                    ledger.confirmJournalSettlement(installation, row.requestId(), HASH);
                    throw new IllegalStateException("synthetic answer validation failure");
                }))
                .isInstanceOf(IllegalStateException.class);
        assertThat(ledger.confirmJournalSettlement(installation, row.requestId(), HASH)
                        .actualMicroUsd())
                .isEqualTo(20);
        rejected(() -> ledger.holdUnknown(installation, row.requestId()), "ALREADY_SETTLED");
    }

    @Test
    void overReservationIsRecordedAndBlocksFurtherAdmissions() {
        active(1000, 1000);
        var row = ledger.reserve(reservation(100));
        var settled = settle(row, 150);
        assertThat(settled.actualMicroUsd()).isEqualTo(150);
        assertThat(ledger.read(installation).orElseThrow().reconciliationRequired())
                .isTrue();
        assertThat(ledger.reconcile(installation).gate().reconciliationRequired())
                .isTrue();
        rejected(() -> ledger.reserve(reservation(1)), "RECONCILIATION_REQUIRED");
    }

    @Test
    void identicalSettlementAckCanBeRetriedAfterANewerReconciliation() {
        active(100, 100);
        var row = ledger.reserve(reservation(100));
        settle(row, 20);
        long originalSequence = main.settlements.get(row.requestId()).position().sequence();
        main.bump();
        ledger.reconcile(installation);
        var retried = ledger.confirmJournalSettlement(installation, row.requestId(), HASH);
        assertThat(retried.actualMicroUsd()).isEqualTo(20);
        assertThat(retried.journalSequence()).isGreaterThan(originalSequence);
        assertThat(ledger.read(installation).orElseThrow().journalSequence()).isEqualTo(main.sequence);
    }

    @Test
    void immutableEvidenceCannotBeUpdatedOrDeletedInPg() {
        active(100, 100);
        var row = ledger.reserve(reservation(100));
        main.usage(row, 10, usage(1, 1));
        ledger.recordMainEvidence(installation, row.requestId(), HASH);
        assertThatThrownBy(() -> sql.update(
                        "update ai_usage_evidence set actual_micro_usd=0 where request_id=?", row.requestId()))
                .isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> sql.update("delete from ai_usage_evidence where request_id=?", row.requestId()))
                .isInstanceOf(DataAccessException.class);
        assertThat(ledger.projection(installation).evidence().getFirst().actualMicroUsd())
                .isEqualTo(10);
    }

    @Test
    void requestIdentityAndFinancialRowsCannotBeDeletedOrChanged() {
        active(100, 100);
        var row = ledger.reserve(reservation(100));
        assertThatThrownBy(() -> sql.update(
                        "update ai_request_ledger set payload_sha256=? where request_id=?",
                        OTHER_HASH,
                        row.requestId()))
                .isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> sql.update("delete from ai_request_ledger where request_id=?", row.requestId()))
                .isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> sql.update("delete from ai_budget_gate where installation_id=?", installation))
                .isInstanceOf(DataAccessException.class);
    }

    @Test
    void productUserProjectDeletionDoesNotEraseFinancialObligations() {
        long user = sql.queryForObject(
                "insert into users (github_id,login) values (?,?) returning id",
                Long.class,
                -Math.abs(UUID.randomUUID().getMostSignificantBits()),
                "cost-fixture");
        long project = sql.queryForObject("""
                insert into projects (user_id,name,repo_owner,repo_name) values (?,'fixture','fixture','fixture') returning id
                """, Long.class, user);
        long snapshot = sql.queryForObject("""
                insert into snapshots (project_id,commit_sha,status) values (?,'fixture','READY') returning id
                """, Long.class, project);
        ledger.initialize(installation, user);
        ledger.configure(installation, user, 0, 100, 100);
        ledger.reconcile(installation);
        var basic = reservation(100);
        var row = ledger.reserve(new AiCostLedger.Reservation(
                basic.requestId(),
                installation,
                user,
                project,
                snapshot,
                basic.approvalId(),
                HASH,
                HASH,
                HASH,
                basic.dispatchBinding(),
                basic.budgetDay(),
                "fixture-1",
                100));
        sql.update("delete from users where id=?", user);
        assertThat(ledger.readRequest(installation, row.requestId())
                        .orElseThrow()
                        .liability())
                .isEqualTo(BigInteger.valueOf(100));
    }

    @Test
    void journalOnlyObligationBecomesANondispatchablePlaceholder() {
        active(100, 100);
        UUID id = UUID.randomUUID();
        main.put(new AiCostLedger.JournalObligation(
                id, HASH, date(), "fixture-1", 50, AiCostLedger.Status.UNKNOWN_HELD, null, null, 50, false));
        var projection = ledger.reconcile(installation);
        var row = projection.requests().getFirst();
        assertThat(row.ownerUserId()).isNull();
        assertThat(row.projectId()).isNull();
        assertThat(row.dispatchBinding()).isNull();
        assertThat(row.hasOriginalBinding()).isFalse();
        rejected(() -> ledger.requireDispatchable(installation, id, main.epoch), "NOT_DISPATCHABLE");
        rejected(() -> ledger.reserve(reservation(51)), "BUDGET_EXCEEDED");
    }

    @Test
    void authoritativeJournalSettlementRecoversPgWithoutRequiringLostPgEvidence() {
        active(100, 100);
        var row = ledger.reserve(reservation(100));
        main.settlement(row, 10);
        var restored = ledger.reconcile(installation).requests().getFirst();
        assertThat(restored.status()).isEqualTo(AiCostLedger.Status.SETTLED);
        assertThat(restored.actualMicroUsd()).isEqualTo(10);
        assertThat(ledger.projection(installation).evidence()).isEmpty();
    }

    @Test
    void newPgReservationBeforeJournalAppendIsLegalDuringReconciliation() {
        active(100, 100);
        clock.value += 100;
        var row = ledger.reserve(reservation(10));
        long highWater = ledger.read(installation).orElseThrow().clockHighWaterMs();
        var reconciled = ledger.reconcile(installation);
        assertThat(reconciled.gate().reconciliationRequired()).isFalse();
        assertThat(reconciled.gate().clockHighWaterMs()).isEqualTo(highWater);
        assertThat(ledger.requireDispatchable(installation, row.requestId(), main.epoch))
                .isEqualTo(row);
    }

    @Test
    void missingJournalDispatchedObligationCannotBeReconciledAway() {
        active(100, 100);
        var row = ledger.reserve(reservation(10));
        main.dispatch(row);
        ledger.markDispatched(installation, row.requestId());
        main.rows.clear();
        main.bump();
        assertThat(ledger.reconcile(installation).gate().reconciliationRequired())
                .isTrue();
        assertThat(ledger.readRequest(installation, row.requestId())
                        .orElseThrow()
                        .liability())
                .isEqualTo(BigInteger.TEN);
    }

    @Test
    void conflictingJournalIdentityRetainsTheLargerLiabilityAndBlocks() {
        active(1000, 1000);
        var row = ledger.reserve(reservation(100));
        main.put(new AiCostLedger.JournalObligation(
                row.requestId(),
                OTHER_HASH,
                date(),
                "other-price",
                200,
                AiCostLedger.Status.UNKNOWN_HELD,
                null,
                null,
                250,
                false));
        var projection = ledger.reconcile(installation);
        var merged = projection.requests().getFirst();
        assertThat(merged.payloadSha256()).isEqualTo(HASH);
        assertThat(merged.reservedMicroUsd()).isEqualTo(100);
        assertThat(merged.conflict()).isTrue();
        assertThat(merged.liability()).isEqualTo(BigInteger.valueOf(250));
        assertThat(projection.gate().reconciliationRequired()).isTrue();
    }

    @Test
    void knownPgSettlementCannotHideLargerRestoredJournalLiability() {
        active(1000, 1000);
        var row = ledger.reserve(reservation(100));
        settle(row, 20);
        main.put(new AiCostLedger.JournalObligation(
                row.requestId(),
                HASH,
                date(),
                "fixture-1",
                100,
                AiCostLedger.Status.UNKNOWN_HELD,
                null,
                null,
                100,
                false));
        var restored = ledger.reconcile(installation).requests().getFirst();
        assertThat(restored.status()).isEqualTo(AiCostLedger.Status.SETTLED);
        assertThat(restored.actualMicroUsd()).isEqualTo(20);
        assertThat(restored.conflict()).isTrue();
        assertThat(restored.liability()).isEqualTo(BigInteger.valueOf(100));
    }

    @Test
    void pendingJournalRestoreCannotClearReconciliation() {
        active(100, 100);
        main.restorePending = true;
        assertThat(ledger.reconcile(installation).gate().reconciliationRequired())
                .isTrue();
    }

    @Test
    void oldJournalPositionCannotRollbackPgHighWater() {
        active(100, 100);
        var row = ledger.reserve(reservation(10));
        main.dispatch(row);
        ledger.markDispatched(installation, row.requestId());
        long before = ledger.read(installation).orElseThrow().journalSequence();
        main.sequence = 1;
        rejected(() -> ledger.reconcile(installation), "JOURNAL_REGRESSION");
        assertThat(ledger.read(installation).orElseThrow().journalSequence()).isEqualTo(before);
    }

    @Test
    void futureJournalBudgetDayStaysBlockedWithoutMintingAPresentDayBudget() {
        active(100, 100);
        main.budgetDay = date().plusDays(1);
        main.bump();
        assertThat(ledger.reconcile(installation).gate().reconciliationRequired())
                .isTrue();
    }

    @Test
    void malformedJournalRejectsTheWholeUnionBeforeAnyWrites() {
        active(100, 100);
        UUID id = UUID.randomUUID();
        var row = new AiCostLedger.JournalObligation(
                id, HASH, date(), "fixture-1", 50, AiCostLedger.Status.UNKNOWN_HELD, null, null, 50, false);
        main.overrideRows = List.of(row, row);
        main.bump();
        rejected(() -> ledger.reconcile(installation), "INVALID_JOURNAL");
        assertThat(ledger.readObligations(installation)).isEmpty();
    }

    @Test
    void aDatabaseFailureMidUnionRollsBackEarlierImportedObligations() {
        active(100, 100);
        String target = installation;
        installation = "cost-fixture-" + UUID.randomUUID();
        active(100, 100);
        var foreign = ledger.reserve(reservation(10));
        installation = target;
        UUID first = UUID.randomUUID();
        main.overrideRows = List.of(
                new AiCostLedger.JournalObligation(
                        first, HASH, date(), "fixture-1", 10, AiCostLedger.Status.UNKNOWN_HELD, null, null, 10, false),
                new AiCostLedger.JournalObligation(
                        foreign.requestId(),
                        HASH,
                        date(),
                        "fixture-1",
                        10,
                        AiCostLedger.Status.UNKNOWN_HELD,
                        null,
                        null,
                        10,
                        false));
        main.bump();
        assertThatThrownBy(() -> ledger.reconcile(target)).isInstanceOf(DataAccessException.class);
        assertThat(ledger.readObligations(target)).isEmpty();
    }

    @Test
    void dispatchBindingRejectsUrlsAndRequiresAnOutputCap() {
        active(100, 100);
        rejected(
                () -> ledger.reserve(withBinding(
                        reservation(1),
                        b -> binding(b, AiCostLedger.Operation.CHAT, 10, "https://example.invalid/private"))),
                "INVALID_IDENTIFIER");
        rejected(
                () -> ledger.reserve(withBinding(
                        reservation(1), b -> binding(b, AiCostLedger.Operation.CHAT, 0, "fixture-endpoint"))),
                "OUTPUT_CAP_REQUIRED");
        assertThat(ledger.readObligations(installation)).isEmpty();
    }

    @Test
    void projectionContainsOnlyTypedMetadataAndDefensiveCollections() {
        active(100, 100);
        var row = ledger.reserve(reservation(10));
        var projection = ledger.projection(installation);
        assertThatThrownBy(() -> projection.requests().clear()).isInstanceOf(UnsupportedOperationException.class);
        String value = sql.queryForObject(
                "select dispatch_binding::text from ai_request_ledger where request_id=?",
                String.class,
                row.requestId());
        assertThat(value)
                .doesNotContain("http://", "https://", "Authorization", "apiKey", "systemPrompt", "requestPlanToken");
        assertThat(value).contains("wireBodyBytes", "costContractSha256", "outputTokenMax");
    }

    private void active(long daily, long monthly) {
        main.journalClock = clock.value;
        ledger.initialize(installation, OWNER);
        ledger.configure(installation, OWNER, 0, daily, monthly);
        assertThat(ledger.reconcile(installation).gate().reconciliationRequired())
                .isFalse();
    }

    private AiCostLedger.Reservation reservation(long amount) {
        var gate = ledger.read(installation).orElseThrow();
        var binding = new AiCostLedger.DispatchBinding(
                main.epoch,
                "fixture",
                "fixture-model",
                AiCostLedger.Operation.CHAT,
                "fixture-endpoint",
                "fixture-adapter-1",
                "fixture-tokenizer",
                "1",
                HASH,
                HASH,
                1,
                gate.policyRevision(),
                gate.policySha256(),
                100,
                10,
                0,
                100,
                clock.value + 600_000);
        return new AiCostLedger.Reservation(
                UUID.randomUUID(),
                installation,
                OWNER,
                11,
                12,
                UUID.randomUUID(),
                HASH,
                HASH,
                HASH,
                binding,
                date(),
                "fixture-1",
                amount);
    }

    private AiCostLedger.Reservation withBinding(
            AiCostLedger.Reservation r, UnaryOperator<AiCostLedger.DispatchBinding> change) {
        return new AiCostLedger.Reservation(
                r.requestId(),
                r.installationId(),
                r.ownerUserId(),
                r.projectId(),
                r.snapshotId(),
                r.approvalId(),
                r.planSha256(),
                r.payloadSha256(),
                r.wireBodySha256(),
                change.apply(r.dispatchBinding()),
                r.budgetDay(),
                r.priceVersion(),
                r.reservedMicroUsd());
    }

    private AiCostLedger.DispatchBinding binding(
            AiCostLedger.DispatchBinding b, AiCostLedger.Operation operation, long output, String endpoint) {
        return new AiCostLedger.DispatchBinding(
                b.mainEpoch(),
                b.provider(),
                b.model(),
                operation,
                endpoint,
                b.adapterVersion(),
                b.tokenizerId(),
                b.tokenizerVersion(),
                b.costContractSha256(),
                b.priceSha256(),
                b.settingsRevision(),
                b.policyRevision(),
                b.policySha256(),
                b.inputTokenUpperBound(),
                output,
                operation == AiCostLedger.Operation.EMBEDDING ? 100 : 0,
                b.wireBodyBytes(),
                b.validUntilEpochMs());
    }

    private AiCostLedger.Request settle(AiCostLedger.Request row, long actual) {
        main.usage(row, actual, usage(1, 1));
        ledger.recordMainEvidence(installation, row.requestId(), HASH);
        main.settlement(row, actual);
        return ledger.confirmJournalSettlement(installation, row.requestId(), HASH);
    }

    private LocalDate date() {
        return Instant.ofEpochMilli(clock.value).atZone(ZoneOffset.UTC).toLocalDate();
    }

    private List<String> parallel(List<AiCostLedger.Reservation> requests) throws Exception {
        CountDownLatch ready = new CountDownLatch(requests.size());
        CountDownLatch start = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(requests.size())) {
            var futures = requests.stream()
                    .map(request -> executor.submit(() -> {
                        ready.countDown();
                        if (!start.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("start timeout");
                        try {
                            ledger.reserve(request);
                            return "OK";
                        } catch (AiCostLedgerException e) {
                            return e.code();
                        }
                    }))
                    .toList();
            assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            List<String> result = new ArrayList<>();
            for (var future : futures) result.add(future.get(10, TimeUnit.SECONDS));
            return result;
        }
    }

    private static AiCostLedger.UsageDimensions usage(long input, long output) {
        return new AiCostLedger.UsageDimensions(Map.of(
                AiCostLedger.UsageDimension.INPUT_TOKENS, input, AiCostLedger.UsageDimension.OUTPUT_TOKENS, output));
    }

    private static void rejected(org.assertj.core.api.ThrowableAssert.ThrowingCallable action, String code) {
        assertThatThrownBy(action).isInstanceOf(AiCostLedgerException.class).hasMessage(code);
    }

    private static final class MutableClock extends Clock {
        volatile long value;

        MutableClock(long value) {
            this.value = value;
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return Instant.ofEpochMilli(value);
        }

        @Override
        public long millis() {
            return value;
        }
    }

    private static final class MainFixture implements AiCostLedger.MainAuthority {
        final MutableClock clock;
        final String epoch = UUID.randomUUID().toString();
        final Map<UUID, AiCostLedger.DispatchReceipt> dispatches = new LinkedHashMap<>();
        final Map<UUID, AiCostLedger.MainEvidence> evidence = new LinkedHashMap<>();
        final Map<UUID, AiCostLedger.SettlementReceipt> settlements = new LinkedHashMap<>();
        final Map<UUID, AiCostLedger.JournalObligation> rows = new LinkedHashMap<>();
        boolean fresh = true;
        boolean restorePending;
        LocalDate budgetDay;
        long sequence = 1;
        long journalClock;
        List<AiCostLedger.JournalObligation> overrideRows;

        MainFixture(MutableClock clock) {
            this.clock = clock;
            journalClock = clock.value;
        }

        @Override
        public Optional<AiCostLedger.FreshEnrollment> findFreshEnrollment(String installation, long owner) {
            return fresh
                    ? Optional.of(new AiCostLedger.FreshEnrollment(installation, owner, epoch, HASH))
                    : Optional.empty();
        }

        @Override
        public AiCostLedger.DispatchReceipt readDispatch(String installation, UUID id) {
            return dispatches.get(id);
        }

        @Override
        public AiCostLedger.MainEvidence readEvidence(String installation, UUID id, String proof) {
            return evidence.get(id);
        }

        @Override
        public AiCostLedger.SettlementReceipt readSettlement(String installation, UUID id, String proof) {
            return settlements.get(id);
        }

        @Override
        public AiCostLedger.JournalView readJournal(String installation) {
            return new AiCostLedger.JournalView(
                    installation,
                    position(),
                    budgetDay == null ? date() : budgetDay,
                    restorePending,
                    overrideRows == null ? List.copyOf(rows.values()) : overrideRows);
        }

        void bump() {
            sequence++;
            journalClock = Math.max(journalClock, clock.value);
        }

        AiCostLedger.Position position() {
            return new AiCostLedger.Position(
                    sequence, String.format("%064x", sequence), String.format("%064x", sequence + 1), journalClock);
        }

        LocalDate date() {
            return Instant.ofEpochMilli(clock.value).atZone(ZoneOffset.UTC).toLocalDate();
        }

        void dispatch(AiCostLedger.Request row) {
            bump();
            rows.put(
                    row.requestId(),
                    new AiCostLedger.JournalObligation(
                            row.requestId(),
                            row.payloadSha256(),
                            row.budgetDay(),
                            row.priceVersion(),
                            row.reservedMicroUsd(),
                            AiCostLedger.Status.DISPATCHED,
                            null,
                            null,
                            row.reservedMicroUsd(),
                            false));
            dispatches.put(
                    row.requestId(),
                    new AiCostLedger.DispatchReceipt(
                            row.installationId(),
                            row.requestId(),
                            epoch,
                            row.payloadSha256(),
                            row.budgetDay(),
                            row.priceVersion(),
                            row.reservedMicroUsd(),
                            position()));
        }

        void usage(AiCostLedger.Request row, long actual, AiCostLedger.UsageDimensions usage) {
            evidence.put(
                    row.requestId(),
                    new AiCostLedger.MainEvidence(
                            row.installationId(),
                            row.requestId(),
                            row.payloadSha256(),
                            row.priceVersion(),
                            HASH,
                            epoch,
                            AiCostLedger.ReceiptType.USAGE,
                            "fixture-provider-request",
                            usage,
                            actual));
        }

        void settlement(AiCostLedger.Request row, long actual) {
            bump();
            rows.put(
                    row.requestId(),
                    new AiCostLedger.JournalObligation(
                            row.requestId(),
                            row.payloadSha256(),
                            row.budgetDay(),
                            row.priceVersion(),
                            row.reservedMicroUsd(),
                            AiCostLedger.Status.SETTLED,
                            actual,
                            HASH,
                            row.reservedMicroUsd(),
                            false));
            settlements.put(
                    row.requestId(),
                    new AiCostLedger.SettlementReceipt(
                            row.installationId(), row.requestId(), row.payloadSha256(), HASH, actual, position()));
        }

        void put(AiCostLedger.JournalObligation row) {
            rows.put(row.requestId(), row);
            bump();
        }
    }
}
