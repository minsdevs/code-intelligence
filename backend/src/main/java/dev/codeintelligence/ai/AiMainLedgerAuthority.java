package dev.codeintelligence.ai;

import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Component;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Private reverse reads from main; no HTTP controller can submit a settlement proof. */
@Component
public final class AiMainLedgerAuthority implements AiCostLedger.MainAuthority {
    private final AiMainGatewayClient client;
    private final JsonMapper json = JsonMapper.builder()
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .build();

    public AiMainLedgerAuthority(AiMainGatewayClient client) {
        this.client = client;
    }

    @Override
    public Optional<AiCostLedger.FreshEnrollment> findFreshEnrollment(String installationId, long ownerUserId) {
        if (!client.enabled()) return Optional.empty();
        JsonNode value = client.exchange(
                "ENROLLMENT", Map.of("installationId", installationId, "ownerUserId", Long.toString(ownerUserId)));
        return value == null || value.isNull()
                ? Optional.empty()
                : Optional.of(decode(value, AiCostLedger.FreshEnrollment.class));
    }

    @Override
    public AiCostLedger.DispatchReceipt readDispatch(String installationId, UUID requestId) {
        return decode(
                client.exchange(
                        "DISPATCH_PROOF", Map.of("installationId", installationId, "requestId", requestId.toString())),
                AiCostLedger.DispatchReceipt.class);
    }

    @Override
    public AiCostLedger.MainEvidence readEvidence(String installationId, UUID requestId, String proofSha256) {
        return decode(
                client.exchange(
                        "USAGE_PROOF",
                        Map.of(
                                "installationId",
                                installationId,
                                "requestId",
                                requestId.toString(),
                                "proofSha256",
                                proofSha256)),
                AiCostLedger.MainEvidence.class);
    }

    @Override
    public AiCostLedger.SettlementReceipt readSettlement(String installationId, UUID requestId, String proofSha256) {
        return decode(
                client.exchange(
                        "SETTLEMENT_PROOF",
                        Map.of(
                                "installationId",
                                installationId,
                                "requestId",
                                requestId.toString(),
                                "proofSha256",
                                proofSha256)),
                AiCostLedger.SettlementReceipt.class);
    }

    @Override
    public AiCostLedger.JournalView readJournal(String installationId) {
        return decode(
                client.exchange("JOURNAL", Map.of("installationId", installationId)), AiCostLedger.JournalView.class);
    }

    private <T> T decode(JsonNode value, Class<T> type) {
        try {
            if (value == null || !value.isObject()) throw new AiSafetyUnavailableException();
            return json.treeToValue(value, type);
        } catch (RuntimeException failure) {
            throw new AiSafetyUnavailableException();
        }
    }
}
