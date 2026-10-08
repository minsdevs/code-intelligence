package dev.codeintelligence.analysis.java;

import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.AnalyzerEvidence;
import dev.codeintelligence.analysis.core.CodeAnalyzer;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphEdgeDraft;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.job.JobCancellation;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/** The annotation visitors share one short-lived syntax tree, never a retained mutable AST. */
@Component
public final class JavaFrameworkAnalyzer implements CodeAnalyzer {
    private static final Logger log = LoggerFactory.getLogger(JavaFrameworkAnalyzer.class);
    private static final long MAX_BYTES = 16L * 1024 * 1024;
    private final JpaEntityExtractor jpa = new JpaEntityExtractor();
    private final KafkaEventExtractor kafka = new KafkaEventExtractor();
    private final LayerTagger layers = new LayerTagger();
    private final SpringEndpointExtractor spring = new SpringEndpointExtractor();
    private Map<String, Entry> cache = Map.of();
    private String environment;
    private record Entry(String blob, List<AnalysisResult> results, long bytes) {}

    @Override
    public boolean supports(FileInventory inventory) {
        return inventory.files().stream().anyMatch(JavaParseSupport::isJava);
    }

    @Override
    public synchronized AnalysisResult analyze(AnalysisContext context) {
        JobCancellation.checkpoint();
        JavaInputFingerprint.Snapshot input = JavaInputFingerprint.capture(context);
        boolean known = input != null && input.environment().equals(environment);
        List<InventoriedFile> files = context.inventory().files().stream().filter(JavaParseSupport::isJava).toList();
        List<InventoriedFile> changed = files.stream().filter(file -> {
            Entry old = known ? cache.get(file.path()) : null;
            return old == null || !old.blob.equals(input.files().get(file.path()));
        }).toList();
        Map<String, Entry> current = new LinkedHashMap<>();
        int reused = 0;
        try (var parsed = JavaParseSupport.parseAhead(context, changed)) {
            Set<String> changedPaths = new HashSet<>();
            for (InventoriedFile file : changed) changedPaths.add(file.path());
            for (InventoriedFile file : files) {
                JobCancellation.checkpoint();
                if (!changedPaths.contains(file.path())) {
                    current.put(file.path(), cache.get(file.path()));
                    reused++;
                    continue;
                }
                JavaParseSupport.ParsedJavaFile unit = parsed.next().value();
                if (unit == null) continue;
                var singleton = List.of(unit);
                List<AnalysisResult> results = List.of(jpa.analyzeFiles(singleton), kafka.analyzeFiles(singleton),
                        layers.analyzeFiles(singleton), spring.analyzeFiles(singleton));
                long bytes = 512;
                for (AnalysisResult result : results) {
                    for (GraphNodeDraft node : result.nodes()) bytes += 128L + node.toString().length() * 2L;
                    for (GraphEdgeDraft edge : result.edges()) bytes += 128L + edge.toString().length() * 2L;
                    for (AnalyzerEvidence evidence : result.evidences()) bytes += 128L + evidence.toString().length() * 2L;
                }
                current.put(file.path(), new Entry(input == null ? "" : input.files().getOrDefault(file.path(), ""), results, bytes));
            }
        }
        List<GraphNodeDraft> nodes = new ArrayList<>();
        List<GraphEdgeDraft> edges = new ArrayList<>();
        List<AnalyzerEvidence> evidences = new ArrayList<>();
        Set<String> topics = new HashSet<>();
        // Preserve the original analyzer-major ordering and Kafka's first-topic declaration rule.
        for (int index = 0; index < 4; index++) {
            for (Entry entry : current.values()) {
                AnalysisResult result = entry.results.get(index);
                for (GraphNodeDraft node : result.nodes())
                    if (index != 1 || topics.add(node.naturalKey())) nodes.add(node);
                edges.addAll(result.edges());
                evidences.addAll(result.evidences());
            }
        }
        JobCancellation.checkpoint();
        Map<String, Entry> bounded = new LinkedHashMap<>();
        long bytes = 0;
        if (input != null) for (var entry : current.entrySet()) {
            if (entry.getValue().bytes > MAX_BYTES - bytes || bounded.size() == 4096) continue;
            bounded.put(entry.getKey(), entry.getValue());
            bytes += entry.getValue().bytes;
        }
        cache = Map.copyOf(bounded);
        environment = input == null ? null : input.environment();
        log.info("Java framework reuse: parsed={}, reused={}, retainedBytes={}", changed.size(), reused, bytes);
        return new AnalysisResult(nodes, edges, evidences);
    }
}
