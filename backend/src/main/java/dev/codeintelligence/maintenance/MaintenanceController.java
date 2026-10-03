package dev.codeintelligence.maintenance;

import dev.codeintelligence.common.security.AuthenticatedUser;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.core.JacksonException;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@RestController
public class MaintenanceController {
    public static final String PATH = "/api/desktop/maintenance";
    public static final String PATH_TOKEN_HEADER = "X-Code-Intelligence-Path-Token";
    private static final JsonMapper JSON = JsonMapper.builder(JsonFactory.builder()
                    .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                    .streamReadConstraints(StreamReadConstraints.builder()
                            .maxDocumentLength(256)
                            .maxNestingDepth(2)
                            .maxTokenCount(8)
                            .maxNameLength(16)
                            .maxStringLength(36)
                            .maxNumberLength(2)
                            .build())
                    .build())
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .build();

    private final MaintenanceService service;

    public MaintenanceController(MaintenanceService service) {
        this.service = service;
    }

    @PostMapping(value = PATH, consumes = MediaType.APPLICATION_JSON_VALUE)
    public MaintenanceGate.View control(
            @RequestBody String body,
            @RequestHeader(name = PATH_TOKEN_HEADER, required = false) String token,
            @AuthenticationPrincipal AuthenticatedUser user) {
        Command command = parse(body);
        return service.control(command.id(), command.operation(), user, token);
    }

    private static Command parse(String body) {
        if (body == null || body.length() > 256) throw invalid();
        try {
            JsonNode value = JSON.readTree(body);
            if (value == null
                    || !value.isObject()
                    || value.size() != 2
                    || !value.has("transactionId")
                    || !value.has("operation")
                    || !value.get("transactionId").isTextual()
                    || !value.get("operation").isTextual()) {
                throw invalid();
            }
            String rawId = value.get("transactionId").stringValue();
            UUID id = UUID.fromString(rawId);
            if (!id.toString().equals(rawId)) throw invalid();
            return new Command(
                    id,
                    MaintenanceService.Operation.valueOf(value.get("operation").stringValue()));
        } catch (JacksonException | IllegalArgumentException error) {
            throw invalid();
        }
    }

    private static ResponseStatusException invalid() {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, "INVALID_MAINTENANCE_REQUEST");
    }

    private record Command(UUID id, MaintenanceService.Operation operation) {}
}
