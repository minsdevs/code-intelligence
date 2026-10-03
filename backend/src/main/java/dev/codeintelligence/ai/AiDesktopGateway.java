package dev.codeintelligence.ai;

import java.math.BigInteger;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Desktop requests use only main-owned transport. Legacy provider methods grant no approval. */
@Service
public final class AiDesktopGateway {
    public static final String MODEL = "gpt-4o-mini-2024-07-18";
    private static final int OUTPUT_CAP = 2048;

    public record Budget(
            boolean available,
            String state,
            String policyRevision,
            String dailyLimitMicroUsd,
            String monthlyLimitMicroUsd,
            String allDatesHeldMicroUsd,
            String dailySettledMicroUsd,
            String monthlySettledMicroUsd,
            List<String> supportedModels,
            String activationToken) {
        @Override
        public String toString() {
            return "AiBudget[redacted]";
        }
    }

    public record Cost(
            String reservedMicroUsd,
            String inputTokenUpperBound,
            String outputTokenMax,
            String priceVersion,
            Instant validUntil,
            String policyRevision) {}

    record Quote(AiCostLedger.Reservation reservation, Cost cost) {}

    private final AiMainGatewayClient main;
    private final AiCostLedger ledger;
    private final JsonMapper json;
    private final AiPreferenceStore preferences;
    private final AiBudgetApprovalStore approvals;

    public AiDesktopGateway(
            AiMainGatewayClient main,
            AiCostLedger ledger,
            JsonMapper json,
            AiPreferenceStore preferences,
            AiBudgetApprovalStore approvals) {
        this.main = main;
        this.ledger = ledger;
        this.json = json;
        this.preferences = preferences;
        this.approvals = approvals;
    }

    public boolean enabled() {
        return main.enabled();
    }

    int activeRequests() {
        JsonNode count = main.exchange("STATUS", Map.of()).path("activeRequests");
        if (!count.isIntegralNumber() || !count.canConvertToInt() || count.intValue() < 0 || count.intValue() > 16)
            throw new AiSafetyUnavailableException();
        return count.intValue();
    }

    public Budget budget(long userId) {
        if (!enabled()) return new Budget(false, "OFF", "0", "0", "0", "0", "0", "0", List.of(), null);
        JsonNode status = main.exchange("STATUS", Map.of());
        String installation = text(status, "installationId");
        ledger.initialize(installation, userId);
        var projection = ledger.projection(installation);
        AiCostLedger.Gate gate = projection.gate();
        if (gate.ownerUserId() != userId) throw new AiSafetyUnavailableException();
        BigInteger held = BigInteger.ZERO, daily = BigInteger.ZERO, monthly = BigInteger.ZERO;
        LocalDate today = LocalDate.now(ZoneOffset.UTC);
        for (var row : projection.requests()) {
            if (row.status() != AiCostLedger.Status.SETTLED || row.conflict()) held = held.add(row.liability());
            else {
                if (today.equals(row.budgetDay())) daily = daily.add(row.liability());
                if (today.getYear() == row.budgetDay().getYear()
                        && today.getMonth() == row.budgetDay().getMonth()) monthly = monthly.add(row.liability());
            }
        }
        String state = gate.legacyLiabilityUnresolved() || gate.reconciliationRequired()
                ? "RECOVERY_REQUIRED"
                : status.path("aiOff").asBoolean(true) ? "OFF" : "READY";
        String activationToken = null;
        if (status.path("aiOff").asBoolean(true)
                && !gate.legacyLiabilityUnresolved()
                && gate.dailyLimitMicroUsd() > 0
                && gate.monthlyLimitMicroUsd() > 0
                && preferences
                        .find(userId)
                        .filter(p -> "ENABLED".equals(p.state()))
                        .isPresent()) {
            activationToken = approvals.issue(
                    userId, approvalBinding(userId, gate, status).digest());
        } else approvals.invalidate(userId);
        return new Budget(
                true,
                state,
                Long.toString(gate.policyRevision()),
                Long.toString(gate.dailyLimitMicroUsd()),
                Long.toString(gate.monthlyLimitMicroUsd()),
                held.toString(),
                daily.toString(),
                monthly.toString(),
                List.of(MODEL),
                activationToken);
    }

    public Budget configure(long userId, String expectedRevision, String daily, String monthly) {
        String installation = installation();
        ledger.initialize(installation, userId);
        main.exchange("LATCH", Map.of());
        ledger.configure(installation, userId, decimal(expectedRevision), decimal(daily), decimal(monthly));
        return budget(userId);
    }

    public Budget activate(long userId, String expectedRevision, String activationToken) {
        JsonNode status = main.exchange("STATUS", Map.of());
        String installation = text(status, "installationId");
        var gate = ledger.read(installation).orElseThrow(AiSafetyUnavailableException::new);
        if (gate.ownerUserId() != userId || gate.policyRevision() != decimal(expectedRevision))
            throw new AiSettingsChangedException();
        ApprovalBinding approval = approvalBinding(userId, gate, status);
        approvals.consume(userId, activationToken, approval.digest());
        main.exchange(
                "ACTIVATE",
                Map.of(
                        "ownerUserId",
                        Long.toString(userId),
                        "policyRevision",
                        expectedRevision,
                        "policySha256",
                        gate.policySha256(),
                        "expectedJournalSequence",
                        approval.sequence(),
                        "expectedJournalHash",
                        approval.hash()));
        return budget(userId);
    }

    void latch() {
        if (enabled()) main.exchange("LATCH", Map.of());
    }

    Quote quote(
            long userId,
            long projectId,
            long snapshotId,
            long settingsRevision,
            String provider,
            String model,
            String requestId,
            String planSha256,
            Instant expiresAt,
            AIProvider.ChatRequest request) {
        JsonNode status = main.exchange("STATUS", Map.of());
        String installation = text(status, "installationId");
        if (!status.path("aiOff").isBoolean()
                || status.path("aiOff").booleanValue()
                || !status.path("recoveryOnly").isBoolean()
                || status.path("recoveryOnly").booleanValue()) throw new AiSafetyUnavailableException();
        if (!"openai".equals(provider) || !MODEL.equals(model)) throw new AiSafetyUnavailableException();
        var gate = ledger.read(installation).orElseThrow(AiSafetyUnavailableException::new);
        if (gate.ownerUserId() != userId
                || gate.legacyLiabilityUnresolved()
                || gate.reconciliationRequired()
                || gate.dailyLimitMicroUsd() == 0
                || gate.monthlyLimitMicroUsd() == 0) throw new AiSafetyUnavailableException();
        byte[] body = json.writeValueAsBytes(Map.of(
                "model",
                model,
                "messages",
                List.of(
                        Map.of("role", "system", "content", request.system()),
                        Map.of("role", "user", "content", request.user())),
                "max_completion_tokens",
                OUTPUT_CAP,
                "response_format",
                Map.of("type", "json_object"),
                "stream",
                false,
                "n",
                1,
                "store",
                false,
                "service_tier",
                "default"));
        UUID approvalId = UUID.randomUUID();
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("requestId", requestId);
        input.put("approvalId", approvalId.toString());
        input.put("planSha256", planSha256);
        input.put("ownerUserId", Long.toString(userId));
        input.put("projectId", Long.toString(projectId));
        input.put("snapshotId", Long.toString(snapshotId));
        input.put("settingsRevision", Long.toString(settingsRevision));
        input.put("provider", provider);
        input.put("model", model);
        input.put("operation", "CHAT");
        input.put("policyRevision", Long.toString(gate.policyRevision()));
        input.put("policySha256", gate.policySha256());
        input.put("budgetDay", LocalDate.now(ZoneOffset.UTC).toString());
        input.put("expiresAt", expiresAt.toEpochMilli());
        input.put("outputTokenCap", Integer.toString(OUTPUT_CAP));
        try {
            input.put("bodyBase64", Base64.getEncoder().encodeToString(body));
            JsonNode value = main.exchange("QUOTE", input);
            var binding = json.treeToValue(value.get("dispatchBinding"), AiCostLedger.DispatchBinding.class);
            var reservation = new AiCostLedger.Reservation(
                    UUID.fromString(requestId),
                    installation,
                    userId,
                    projectId,
                    snapshotId,
                    approvalId,
                    planSha256,
                    text(value, "payloadSha256"),
                    text(value, "wireBodySha256"),
                    binding,
                    LocalDate.parse(text(value, "budgetDay")),
                    text(value, "priceVersion"),
                    decimal(text(value, "reservedMicroUsd")));
            if (!requestId.equals(text(value, "requestId"))
                    || !installation.equals(text(value, "installationId"))
                    || !planSha256.equals(text(value, "planSha256"))
                    || !approvalId.toString().equals(text(value, "approvalId")))
                throw new AiSafetyUnavailableException();
            return new Quote(
                    reservation,
                    new Cost(
                            text(value, "reservedMicroUsd"),
                            Long.toString(binding.inputTokenUpperBound()),
                            Long.toString(binding.outputTokenMax()),
                            reservation.priceVersion(),
                            Instant.ofEpochMilli(binding.validUntilEpochMs()),
                            Long.toString(binding.policyRevision())));
        } catch (RuntimeException failure) {
            throw new AiSafetyUnavailableException();
        } finally {
            java.util.Arrays.fill(body, (byte) 0);
            input.clear();
        }
    }

    AIProvider.ChatResponse execute(Quote quote) {
        var reservation = quote.reservation();
        ledger.reserve(reservation);
        try {
            main.exchange(
                    "APPROVE",
                    Map.of(
                            "requestId",
                            reservation.requestId().toString(),
                            "approvalId",
                            reservation.approvalId().toString(),
                            "payloadSha256",
                            reservation.payloadSha256()));
            JsonNode result = main.exchange(
                    "EXECUTE",
                    Map.of(
                            "requestId",
                            reservation.requestId().toString(),
                            "payloadSha256",
                            reservation.payloadSha256()));
            if (!reservation.requestId().toString().equals(text(result, "requestId"))
                    || !reservation.payloadSha256().equals(text(result, "payloadSha256")))
                throw new AiSafetyUnavailableException();
            var row = ledger.readRequest(reservation.installationId(), reservation.requestId())
                    .orElseThrow(AiSafetyUnavailableException::new);
            if (row.status() != AiCostLedger.Status.SETTLED
                    || !text(result, "proofSha256").equals(row.proofSha256())
                    || decimal(text(result, "actualMicroUsd")) != row.actualMicroUsd())
                throw new AiSafetyUnavailableException();
            byte[] bytes = Base64.getDecoder().decode(text(result, "bodyBase64"));
            try {
                if (bytes.length > 2 * 1024 * 1024) throw new AiSafetyUnavailableException();
                JsonNode response = json.readTree(bytes);
                JsonNode message =
                        response.path("choices").path(0).path("message").path("content");
                if (!message.isTextual()) throw new AiSafetyUnavailableException();
                JsonNode usage = response.path("usage");
                return LlmJson.parse(
                        json,
                        message.stringValue(),
                        usage.path("prompt_tokens").intValue(),
                        usage.path("completion_tokens").intValue());
            } finally {
                java.util.Arrays.fill(bytes, (byte) 0);
            }
        } catch (RuntimeException failure) {
            // Even a pre-send failure keeps the reservation until authoritative reconciliation.
            try {
                var current = ledger.readRequest(reservation.installationId(), reservation.requestId());
                if (current.isPresent() && current.get().status() != AiCostLedger.Status.SETTLED)
                    ledger.holdUnknown(reservation.installationId(), reservation.requestId());
            } catch (RuntimeException ignored) {
                /* The committed reservation is never deleted. */
            }
            throw new AiSafetyUnavailableException();
        }
    }

    private String installation() {
        return text(main.exchange("STATUS", Map.of()), "installationId");
    }

    private record ApprovalBinding(String digest, String sequence, String hash) {}

    private ApprovalBinding approvalBinding(long userId, AiCostLedger.Gate gate, JsonNode status) {
        JsonNode journal = main.exchange("JOURNAL", Map.of("installationId", gate.installationId()));
        JsonNode position = journal.path("position");
        String sequence = text(position, "sequence"), hash = text(position, "hash");
        var preference = preferences.find(userId).orElseThrow(AiSafetyUnavailableException::new);
        Map<String, Object> binding = new LinkedHashMap<>();
        binding.put("owner", Long.toString(userId));
        binding.put("installation", gate.installationId());
        binding.put("mainEpoch", text(status, "mainEpoch"));
        binding.put("sequence", sequence);
        binding.put("hash", hash);
        binding.put("policyRevision", Long.toString(gate.policyRevision()));
        binding.put("policyHash", gate.policySha256());
        binding.put("settingsRevision", Long.toString(preference.revision()));
        binding.put("settingsState", preference.state());
        return new ApprovalBinding(AiRequestPlanStore.hash(json.writeValueAsString(binding)), sequence, hash);
    }

    static long decimal(String value) {
        try {
            if (value == null || !value.matches("0|[1-9][0-9]{0,18}")) throw new IllegalArgumentException();
            return Long.parseLong(value);
        } catch (IllegalArgumentException invalid) {
            throw new InvalidAiSettingsException("Use a nonnegative amount with at most six decimal places.");
        }
    }

    private static String text(JsonNode value, String name) {
        if (value == null || !value.path(name).isTextual()) throw new AiSafetyUnavailableException();
        return value.get(name).stringValue();
    }
}
