package dev.codeintelligence.analysis.ts;

import java.util.List;
import tools.jackson.databind.json.JsonMapper;

/** Bounds retained source text and the actual JSON wire body without splitting project context. */
final class TsRequestBudget {
    static final int MAX_FILES = 20_000;
    static final int MAX_BYTES = 10 * 1024 * 1024;
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private long bytes = JSON.writeValueAsBytes(new TsAnalyzeDtos.Request(List.of())).length;
    private int files;

    void add(TsAnalyzeDtos.FilePayload file) {
        if (!tryAdd(file)) requireWithinLimit(files + 1, Long.MAX_VALUE);
    }

    /** Adds the file when the single request stays within its limits; otherwise leaves the budget unchanged. */
    boolean tryAdd(TsAnalyzeDtos.FilePayload file) {
        long next = bytes + JSON.writeValueAsBytes(file).length + (files == 0 ? 0 : 1);
        if (files + 1 > MAX_FILES || next > MAX_BYTES) return false;
        bytes = next;
        files++;
        return true;
    }

    static byte[] encode(TsAnalyzeDtos.Request request) {
        TsRequestBudget budget = new TsRequestBudget();
        request.files().forEach(budget::add);
        byte[] encoded = JSON.writeValueAsBytes(request);
        requireWithinLimit(request.files().size(), encoded.length);
        return encoded;
    }

    private static void requireWithinLimit(int files, long bytes) {
        if (files > MAX_FILES || bytes > MAX_BYTES) {
            throw new TsAnalyzerException(
                    "Project analysis exceeds the 20000-file / 10 MiB JSON limit. Narrow the source scope; "
                            + "partial independent batches would lose project context.",
                    null);
        }
    }
}
