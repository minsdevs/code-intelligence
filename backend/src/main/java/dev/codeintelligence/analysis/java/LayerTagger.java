package dev.codeintelligence.analysis.java;

import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.CodeAnalyzer;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.GraphNodeType;
import dev.codeintelligence.analysis.core.NaturalKeys;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Writes {@code graph_nodes.metadata.layer} for Spring stereotype / JPA types. Metadata is merged
 * onto existing CLASS/INTERFACE nodes during SOURCE_PARSING persist.
 */
@Component
public class LayerTagger implements CodeAnalyzer {

    @Override
    public boolean supports(FileInventory inventory) {
        return inventory.hasLanguage("java") || inventory.files().stream().anyMatch(JavaParseSupport::isJava);
    }

    @Override
    public AnalysisResult analyze(AnalysisContext ctx) {
        List<GraphNodeDraft> nodes = new ArrayList<>();
        for (JavaParseSupport.ParsedJavaFile unit : JavaParseSupport.parseJavaFiles(ctx)) {
            for (TypeDeclaration<?> type : unit.cu().getTypes()) {
                tagType(type, unit, nodes);
            }
        }
        return new AnalysisResult(nodes, List.of(), List.of());
    }

    private void tagType(TypeDeclaration<?> type, JavaParseSupport.ParsedJavaFile unit, List<GraphNodeDraft> nodes) {
        String layer = layerOf(type);
        if (layer != null) {
            String fqcn = JavaParseSupport.fqcn(unit.pkg(), type);
            GraphNodeType kind = type instanceof ClassOrInterfaceDeclaration coi && coi.isInterface()
                    ? GraphNodeType.INTERFACE
                    : GraphNodeType.CLASS;
            nodes.add(GraphNodeDraft.of(
                            kind,
                            NaturalKeys.javaType(fqcn),
                            type.getNameAsString(),
                            unit.file().path(),
                            JavaParseSupport.lineStart(type),
                            JavaParseSupport.lineEnd(type))
                    .withMetadata(Map.of("layer", layer)));
        }
        for (var member : type.getMembers()) {
            if (member instanceof TypeDeclaration<?> nested) {
                tagType(nested, unit, nodes);
            }
        }
    }

    private static String layerOf(TypeDeclaration<?> type) {
        if (JavaParseSupport.hasAnnotation(type, "RestController", "Controller")) {
            return "CONTROLLER";
        }
        if (JavaParseSupport.hasAnnotation(type, "Service")) {
            return "SERVICE";
        }
        if (JavaParseSupport.hasAnnotation(type, "Repository") || extendsJpaRepository(type)) {
            return "REPOSITORY";
        }
        if (JavaParseSupport.hasAnnotation(type, "Entity")) {
            return "ENTITY";
        }
        if (JavaParseSupport.hasAnnotation(type, "Configuration", "SpringBootApplication")) {
            return "CONFIG";
        }
        return null;
    }

    private static boolean extendsJpaRepository(TypeDeclaration<?> type) {
        if (!(type instanceof ClassOrInterfaceDeclaration coi)) {
            return false;
        }
        for (ClassOrInterfaceType ext : coi.getExtendedTypes()) {
            String name = ext.getNameAsString();
            if ("JpaRepository".equals(name)
                    || "CrudRepository".equals(name)
                    || "PagingAndSortingRepository".equals(name)
                    || "ListCrudRepository".equals(name)
                    || name.endsWith("JpaRepository")) {
                return true;
            }
        }
        return false;
    }
}
