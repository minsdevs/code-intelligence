package dev.codeintelligence.analysis.graph;

import dev.codeintelligence.analysis.config.*;
import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisCacheWeight;
import dev.codeintelligence.analysis.core.AnalysisInputFingerprint;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.CodeAnalyzer;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/** Whole-input reuse for known deterministic config analyzers; unknown analyzers always execute. */
final class SourceResultCache {
    private static final Set<Class<?>> SUPPORTED = Set.of(BuildFileAnalyzer.class, DockerAnalyzer.class,
            GithubActionsAnalyzer.class, KubernetesAnalyzer.class, ServerlessAnalyzer.class,
            SqlMigrationAnalyzer.class, TerraformAnalyzer.class, VercelAnalyzer.class, YamlConfigAnalyzer.class);
    private static final long MAX_BYTES = 16L * 1024 * 1024;
    private final Map<Class<?>, Entry> entries = new LinkedHashMap<>();
    private long bytes;
    private record Entry(String key, AnalysisResult result, long bytes) {}

    static boolean supports(CodeAnalyzer analyzer) { return SUPPORTED.contains(analyzer.getClass()); }

    AnalysisResult analyze(CodeAnalyzer analyzer, AnalysisContext context, String fingerprint) {
        AnalysisInputFingerprint.checkpoint();
        if (fingerprint == null || !supports(analyzer)) return analyzer.analyze(context);
        synchronized (this) {
            Entry previous = entries.get(analyzer.getClass());
            if (previous != null && previous.key.equals(fingerprint)) return previous.result;
        }
        AnalysisResult result = analyzer.analyze(context);
        AnalysisInputFingerprint.checkpoint();
        long weight = AnalysisCacheWeight.of(result);
        synchronized (this) {
            Entry removed = entries.remove(analyzer.getClass());
            if (removed != null) bytes -= removed.bytes;
            if (weight > MAX_BYTES) return result;
            var iterator = entries.values().iterator();
            while (bytes + weight > MAX_BYTES && iterator.hasNext()) {
                bytes -= iterator.next().bytes;
                iterator.remove();
            }
            entries.put(analyzer.getClass(), new Entry(fingerprint, result, weight));
            bytes += weight;
        }
        return result;
    }
}
