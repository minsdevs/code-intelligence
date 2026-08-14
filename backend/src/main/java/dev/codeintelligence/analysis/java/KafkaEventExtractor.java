package dev.codeintelligence.analysis.java;

import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import dev.codeintelligence.analysis.area.AreaType;
import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.AnalyzerEvidence;
import dev.codeintelligence.analysis.core.CodeAnalyzer;
import dev.codeintelligence.analysis.core.EdgeConfidence;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphEdgeDraft;
import dev.codeintelligence.analysis.core.GraphEdgeType;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.GraphNodeType;
import dev.codeintelligence.analysis.core.NaturalKeys;
import dev.codeintelligence.evidence.EvidenceKind;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** {@code @KafkaListener} / {@code KafkaTemplate.send} → QUEUE_TOPIC + SUBSCRIBES/PUBLISHES. */
@Component
public class KafkaEventExtractor implements CodeAnalyzer {

    @Override
    public boolean supports(FileInventory inventory) {
        return inventory.hasLanguage("java") || inventory.files().stream().anyMatch(JavaParseSupport::isJava);
    }

    @Override
    public AnalysisResult analyze(AnalysisContext ctx) {
        List<GraphNodeDraft> nodes = new ArrayList<>();
        List<GraphEdgeDraft> edges = new ArrayList<>();
        List<AnalyzerEvidence> evidences = new ArrayList<>();
        Map<String, GraphNodeDraft> topics = new LinkedHashMap<>();
        for (JavaParseSupport.ParsedJavaFile unit : JavaParseSupport.parseJavaFiles(ctx)) {
            for (TypeDeclaration<?> type : unit.cu().getTypes()) {
                String typeKey = NaturalKeys.javaType(JavaParseSupport.fqcn(unit.pkg(), type));
                type.walk(MethodDeclaration.class, method -> {
                    JavaParseSupport.findAnnotation(method, "KafkaListener")
                            .flatMap(KafkaEventExtractor::topicFromAnnotation)
                            .ifPresent(topic -> addTopic(
                                    topic,
                                    typeKey,
                                    GraphEdgeType.SUBSCRIBES,
                                    unit.file().path(),
                                    JavaParseSupport.lineStart(method),
                                    topics,
                                    nodes,
                                    edges,
                                    evidences));
                    method.walk(MethodCallExpr.class, call -> {
                        if (!"send".equals(call.getNameAsString())
                                || call.getArguments().isEmpty()) {
                            return;
                        }
                        String scope = call.getScope().map(Expression::toString).orElse("");
                        if (!scope.toLowerCase().contains("kafka")) {
                            return;
                        }
                        if (!(call.getArgument(0) instanceof StringLiteralExpr literal)) {
                            return;
                        }
                        addTopic(
                                literal.getValue(),
                                typeKey,
                                GraphEdgeType.PUBLISHES,
                                unit.file().path(),
                                JavaParseSupport.lineStart(call),
                                topics,
                                nodes,
                                edges,
                                evidences);
                    });
                });
            }
        }
        return new AnalysisResult(nodes, edges, evidences);
    }

    private static void addTopic(
            String topic,
            String typeKey,
            GraphEdgeType edgeType,
            String filePath,
            Integer line,
            Map<String, GraphNodeDraft> topics,
            List<GraphNodeDraft> nodes,
            List<GraphEdgeDraft> edges,
            List<AnalyzerEvidence> evidences) {
        if (topic == null || topic.isBlank()) {
            return;
        }
        String key = NaturalKeys.topic(topic);
        GraphNodeDraft existing = topics.get(key);
        if (existing == null) {
            GraphNodeDraft node = new GraphNodeDraft(
                    GraphNodeType.QUEUE_TOPIC.name(),
                    key,
                    topic,
                    filePath,
                    line,
                    line,
                    AreaType.BACKEND.name(),
                    Map.of("topic", topic));
            topics.put(key, node);
            nodes.add(node);
        }
        edges.add(GraphEdgeDraft.of(typeKey, key, edgeType, EdgeConfidence.CONFIRMED));
        evidences.add(
                new AnalyzerEvidence(key, EvidenceKind.FILE_LINE, filePath, line, line, edgeType.name() + " " + topic));
    }

    private static java.util.Optional<String> topicFromAnnotation(AnnotationExpr annotation) {
        if (annotation.isSingleMemberAnnotationExpr()) {
            return literal(annotation.asSingleMemberAnnotationExpr().getMemberValue());
        }
        if (annotation.isNormalAnnotationExpr()) {
            for (var pair : annotation.asNormalAnnotationExpr().getPairs()) {
                if ("topics".equals(pair.getNameAsString())
                        || "topic".equals(pair.getNameAsString())
                        || "value".equals(pair.getNameAsString())) {
                    return literal(pair.getValue());
                }
            }
        }
        return java.util.Optional.empty();
    }

    private static java.util.Optional<String> literal(Expression expression) {
        if (expression instanceof StringLiteralExpr string) {
            return java.util.Optional.of(string.getValue());
        }
        if (expression.isArrayInitializerExpr()) {
            return expression.asArrayInitializerExpr().getValues().stream()
                    .findFirst()
                    .flatMap(KafkaEventExtractor::literal);
        }
        return java.util.Optional.empty();
    }
}
