package dev.codeintelligence.analysis.java;

import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.expr.AnnotationExpr;
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

/**
 * {@code @RestController} (or {@code @Controller}+{@code @ResponseBody}) path synthesis →
 * API_ENDPOINT nodes and EXPOSES edges (controller type → endpoint).
 */
@Component
public class SpringEndpointExtractor implements CodeAnalyzer {

    @Override
    public boolean supports(FileInventory inventory) {
        return inventory.hasLanguage("java") || inventory.files().stream().anyMatch(JavaParseSupport::isJava);
    }

    @Override
    public AnalysisResult analyze(AnalysisContext ctx) {
        List<GraphNodeDraft> nodes = new ArrayList<>();
        List<GraphEdgeDraft> edges = new ArrayList<>();
        List<AnalyzerEvidence> evidences = new ArrayList<>();
        for (JavaParseSupport.ParsedJavaFile unit : JavaParseSupport.parseJavaFiles(ctx)) {
            for (TypeDeclaration<?> type : unit.cu().getTypes()) {
                extractType(type, unit, nodes, edges, evidences);
            }
        }
        return new AnalysisResult(nodes, edges, evidences);
    }

    private void extractType(
            TypeDeclaration<?> type,
            JavaParseSupport.ParsedJavaFile unit,
            List<GraphNodeDraft> nodes,
            List<GraphEdgeDraft> edges,
            List<AnalyzerEvidence> evidences) {
        if (!isRestController(type)) {
            for (var member : type.getMembers()) {
                if (member instanceof TypeDeclaration<?> nested) {
                    extractType(nested, unit, nodes, edges, evidences);
                }
            }
            return;
        }
        String fqcn = JavaParseSupport.fqcn(unit.pkg(), type);
        String typeKey = NaturalKeys.javaType(fqcn);
        List<String> classPrefixes = classPrefixes(type);
        for (MethodDeclaration method : type.getMethods()) {
            extractMethod(
                    method,
                    fqcn,
                    typeKey,
                    classPrefixes,
                    unit.cu(),
                    unit.pkg(),
                    unit.file().path(),
                    nodes,
                    edges,
                    evidences);
        }
        for (var member : type.getMembers()) {
            if (member instanceof TypeDeclaration<?> nested) {
                extractType(nested, unit, nodes, edges, evidences);
            }
        }
    }

    private void extractMethod(
            MethodDeclaration method,
            String fqcn,
            String typeKey,
            List<String> classPrefixes,
            CompilationUnit cu,
            String pkg,
            String filePath,
            List<GraphNodeDraft> nodes,
            List<GraphEdgeDraft> edges,
            List<AnalyzerEvidence> evidences) {
        for (AnnotationExpr annotation : method.getAnnotations()) {
            String simple = JavaParseSupport.simpleName(annotation);
            if (!RequestMappings.isMappingAnnotation(simple)) {
                continue;
            }
            List<String> httpMethods = RequestMappings.httpMethods(annotation);
            if (httpMethods.isEmpty()) {
                continue;
            }
            List<String> methodPaths = RequestMappings.paths(annotation);
            List<String> params = method.getParameters().stream()
                    .map(parameter -> JavaTypeNames.resolve(parameter.getType(), cu, pkg))
                    .toList();
            String handlerKey = NaturalKeys.javaMethod(fqcn, method.getNameAsString(), params);
            for (String httpMethod : httpMethods) {
                for (String classPrefix : classPrefixes) {
                    for (String methodPath : methodPaths) {
                        String path = RequestMappings.join(classPrefix, methodPath);
                        String naturalKey = NaturalKeys.endpoint(httpMethod, path);
                        Map<String, Object> metadata = new LinkedHashMap<>();
                        metadata.put("httpMethod", httpMethod);
                        metadata.put("path", path);
                        metadata.put("handlerKey", handlerKey);
                        nodes.add(new GraphNodeDraft(
                                GraphNodeType.API_ENDPOINT.name(),
                                naturalKey,
                                httpMethod + " " + path,
                                filePath,
                                JavaParseSupport.lineStart(method),
                                JavaParseSupport.lineEnd(method),
                                "BACKEND",
                                metadata));
                        edges.add(GraphEdgeDraft.of(
                                typeKey, naturalKey, GraphEdgeType.EXPOSES, EdgeConfidence.CONFIRMED));
                        evidences.add(new AnalyzerEvidence(
                                naturalKey,
                                EvidenceKind.FILE_LINE,
                                filePath,
                                JavaParseSupport.lineStart(method),
                                JavaParseSupport.lineEnd(method),
                                JavaParseSupport.excerpt(method)));
                    }
                }
            }
        }
    }

    private static boolean isRestController(TypeDeclaration<?> type) {
        if (JavaParseSupport.hasAnnotation(type, "RestController")) {
            return true;
        }
        if (!JavaParseSupport.hasAnnotation(type, "Controller")) {
            return false;
        }
        if (JavaParseSupport.hasAnnotation(type, "ResponseBody")) {
            return true;
        }
        if (type instanceof ClassOrInterfaceDeclaration) {
            return type.getMethods().stream()
                    .anyMatch(method -> JavaParseSupport.hasAnnotation(method, "ResponseBody"));
        }
        return false;
    }

    private static List<String> classPrefixes(TypeDeclaration<?> type) {
        for (AnnotationExpr annotation : type.getAnnotations()) {
            if ("RequestMapping".equals(JavaParseSupport.simpleName(annotation))) {
                List<String> paths = RequestMappings.paths(annotation);
                return paths.isEmpty() ? List.of("") : paths;
            }
        }
        return List.of("");
    }
}
