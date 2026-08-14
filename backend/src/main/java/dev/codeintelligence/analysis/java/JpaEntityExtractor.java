package dev.codeintelligence.analysis.java;

import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.MemberValuePair;
import com.github.javaparser.ast.expr.NormalAnnotationExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.AnalyzerEvidence;
import dev.codeintelligence.analysis.core.CodeAnalyzer;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.GraphNodeType;
import dev.codeintelligence.analysis.core.NaturalKeys;
import dev.codeintelligence.evidence.EvidenceKind;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * {@code @Entity}/{@code @Table} → DB_ENTITY nodes. MAPS_TO matching against migration tables is
 * Phase 2 (§11.2).
 */
@Component
public class JpaEntityExtractor implements CodeAnalyzer {

    @Override
    public boolean supports(FileInventory inventory) {
        return inventory.hasLanguage("java") || inventory.files().stream().anyMatch(JavaParseSupport::isJava);
    }

    @Override
    public AnalysisResult analyze(AnalysisContext ctx) {
        List<GraphNodeDraft> nodes = new ArrayList<>();
        List<AnalyzerEvidence> evidences = new ArrayList<>();
        for (JavaParseSupport.ParsedJavaFile unit : JavaParseSupport.parseJavaFiles(ctx)) {
            for (TypeDeclaration<?> type : unit.cu().getTypes()) {
                extractType(type, unit, nodes, evidences);
            }
        }
        return new AnalysisResult(nodes, List.of(), evidences);
    }

    private void extractType(
            TypeDeclaration<?> type,
            JavaParseSupport.ParsedJavaFile unit,
            List<GraphNodeDraft> nodes,
            List<AnalyzerEvidence> evidences) {
        if (JavaParseSupport.hasAnnotation(type, "Entity")) {
            String fqcn = JavaParseSupport.fqcn(unit.pkg(), type);
            String entityName = type.getNameAsString();
            String tableName = tableName(type, entityName);
            String naturalKey = NaturalKeys.entity(fqcn);
            Map<String, Object> metadata = new LinkedHashMap<>();
            metadata.put("entityName", entityName);
            metadata.put("tableName", tableName);
            metadata.put("source", "JPA");
            nodes.add(new GraphNodeDraft(
                    GraphNodeType.DB_ENTITY.name(),
                    naturalKey,
                    entityName,
                    unit.file().path(),
                    JavaParseSupport.lineStart(type),
                    JavaParseSupport.lineEnd(type),
                    "DATABASE",
                    metadata));
            evidences.add(new AnalyzerEvidence(
                    naturalKey,
                    EvidenceKind.FILE_LINE,
                    unit.file().path(),
                    JavaParseSupport.lineStart(type),
                    JavaParseSupport.lineEnd(type),
                    JavaParseSupport.excerpt(type)));
        }
        for (var member : type.getMembers()) {
            if (member instanceof TypeDeclaration<?> nested) {
                extractType(nested, unit, nodes, evidences);
            }
        }
    }

    private static String tableName(TypeDeclaration<?> type, String entityName) {
        return JavaParseSupport.findAnnotation(type, "Table")
                .flatMap(JpaEntityExtractor::tableNameAttribute)
                .filter(name -> !name.isBlank())
                .orElseGet(() -> RequestMappings.toSnakeCase(entityName));
    }

    private static java.util.Optional<String> tableNameAttribute(AnnotationExpr annotation) {
        if (annotation.isSingleMemberAnnotationExpr()) {
            return literal(annotation.asSingleMemberAnnotationExpr().getMemberValue());
        }
        if (annotation.isNormalAnnotationExpr()) {
            NormalAnnotationExpr normal = annotation.asNormalAnnotationExpr();
            for (MemberValuePair pair : normal.getPairs()) {
                if ("name".equals(pair.getNameAsString()) || "value".equals(pair.getNameAsString())) {
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
        return java.util.Optional.empty();
    }
}
