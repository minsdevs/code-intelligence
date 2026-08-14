package dev.codeintelligence.analysis.java;

import com.github.javaparser.JavaParser;
import com.github.javaparser.ParseResult;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.ImportDeclaration;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.AnnotationDeclaration;
import com.github.javaparser.ast.body.CallableDeclaration;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.ConstructorDeclaration;
import com.github.javaparser.ast.body.EnumConstantDeclaration;
import com.github.javaparser.ast.body.EnumDeclaration;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.RecordDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.ast.nodeTypes.NodeWithAnnotations;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import com.github.javaparser.resolution.UnsolvedSymbolException;
import com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration;
import com.github.javaparser.resolution.declarations.ResolvedReferenceTypeDeclaration;
import com.github.javaparser.resolution.types.ResolvedType;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.CombinedTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.JavaParserTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.ReflectionTypeSolver;
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
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.analysis.core.NaturalKeys;
import dev.codeintelligence.evidence.EvidenceKind;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * JavaParser + JavaSymbolSolver analyzer (§10.2). ReflectionTypeSolver is JRE-only so library
 * methods (e.g. JpaRepository) stay unresolved and become CALLS/POSSIBLE; in-source calls are
 * CONFIRMED.
 */
@Component
public class JavaAnalyzer implements CodeAnalyzer {

    private static final Logger log = LoggerFactory.getLogger(JavaAnalyzer.class);
    private static final int EXCERPT_LEN = 80;

    @Override
    public boolean supports(FileInventory inventory) {
        return inventory.hasLanguage("java")
                || inventory.files().stream()
                        .anyMatch(file -> file.path().toLowerCase(Locale.ROOT).endsWith(".java"));
    }

    @Override
    public AnalysisResult analyze(AnalysisContext ctx) {
        Collector collector = new Collector();
        Set<Path> sourceRoots = JavaSourceRoots.find(ctx.clonePath());
        collector.projectTypes.addAll(JavaSourceRoots.projectTypes(sourceRoots));
        JavaParser parser = createParser(sourceRoots);
        List<ParsedUnit> units = new ArrayList<>();
        for (InventoriedFile file :
                ctx.inventory().files().stream().filter(JavaAnalyzer::isJava).toList()) {
            try {
                units.add(parseFile(ctx, parser, file));
            } catch (Exception e) {
                log.warn("Skipping Java file {}: {}", file.path(), e.toString());
                collector.evidences.add(parseFailure(file, e, ctx.clonePath()));
            }
        }
        for (ParsedUnit unit : units) {
            registerTypes(unit, collector);
        }
        for (ParsedUnit unit : units) {
            visitMembers(unit, collector);
        }
        for (ParsedUnit unit : units) {
            visitCalls(unit, collector);
        }
        return collector.toResult();
    }

    private static boolean isJava(InventoriedFile file) {
        return "java".equalsIgnoreCase(file.language())
                || file.path().toLowerCase(Locale.ROOT).endsWith(".java");
    }

    private JavaParser createParser(Set<Path> sourceRoots) {
        CombinedTypeSolver typeSolver = new CombinedTypeSolver();
        for (Path root : sourceRoots) {
            if (Files.isDirectory(root)) {
                typeSolver.add(new JavaParserTypeSolver(root));
            }
        }
        typeSolver.add(new ReflectionTypeSolver(true));
        ParserConfiguration configuration = new ParserConfiguration();
        configuration.setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_21);
        configuration.setSymbolResolver(new JavaSymbolSolver(typeSolver));
        return new JavaParser(configuration);
    }

    private ParsedUnit parseFile(AnalysisContext ctx, JavaParser parser, InventoriedFile file) {
        Path absolute = ctx.clonePath().resolve(file.path()).normalize();
        if (!Files.isRegularFile(absolute)) {
            throw new IllegalStateException("file missing");
        }
        ParseResult<CompilationUnit> parsed;
        try {
            parsed = parser.parse(absolute);
        } catch (java.io.IOException e) {
            throw new IllegalStateException(sanitize(e.getMessage(), ctx.clonePath()), e);
        }
        if (!parsed.isSuccessful() || parsed.getResult().isEmpty()) {
            String detail = parsed.getProblems().isEmpty()
                    ? "parse failed"
                    : parsed.getProblems().getFirst().getVerboseMessage();
            throw new IllegalStateException(sanitize(detail, ctx.clonePath()));
        }
        CompilationUnit cu = parsed.getResult().get();
        String pkg =
                cu.getPackageDeclaration().map(decl -> decl.getNameAsString()).orElse("");
        return new ParsedUnit(file, cu, pkg);
    }

    private void registerTypes(ParsedUnit unit, Collector collector) {
        if (!unit.pkg.isBlank()) {
            collector.put(GraphNodeDraft.of(
                    GraphNodeType.PACKAGE,
                    NaturalKeys.javaType(unit.pkg),
                    unit.pkg,
                    unit.file.path(),
                    lineStart(unit.cu),
                    lineEnd(unit.cu)));
        }
        for (TypeDeclaration<?> type : unit.cu.getTypes()) {
            registerType(type, unit.pkg, unit.file.path(), collector);
        }
    }

    private void registerType(TypeDeclaration<?> type, String pkg, String filePath, Collector collector) {
        String fqcn = fqcn(pkg, type);
        collector.projectTypes.add(fqcn);
        String typeKey = NaturalKeys.javaType(fqcn);
        collector.put(GraphNodeDraft.of(
                nodeTypeOf(type), typeKey, type.getNameAsString(), filePath, lineStart(type), lineEnd(type)));
        collector.evidences.add(declarationEvidence(typeKey, filePath, type));
        if (!pkg.isBlank()) {
            collector.edge(NaturalKeys.javaType(pkg), typeKey, GraphEdgeType.DECLARES, EdgeConfidence.CONFIRMED);
        }
        for (TypeDeclaration<?> nested : nestedTypes(type)) {
            registerType(nested, fqcn, filePath, collector);
        }
    }

    private void visitMembers(ParsedUnit unit, Collector collector) {
        for (TypeDeclaration<?> type : unit.cu.getTypes()) {
            visitTypeMembers(unit.cu, type, unit.pkg, unit.file.path(), collector);
        }
    }

    private void visitCalls(ParsedUnit unit, Collector collector) {
        for (TypeDeclaration<?> type : unit.cu.getTypes()) {
            visitTypeCalls(unit.cu, type, unit.pkg, unit.file.path(), collector);
        }
    }

    private void visitTypeMembers(
            CompilationUnit cu, TypeDeclaration<?> type, String pkg, String filePath, Collector collector) {
        String fqcn = fqcn(pkg, type);
        String typeKey = NaturalKeys.javaType(fqcn);
        annotate(type, typeKey, cu, pkg, filePath, collector);
        visitImports(cu, typeKey, collector);
        if (type instanceof ClassOrInterfaceDeclaration coi) {
            visitHeritage(coi, typeKey, cu, pkg, filePath, collector);
        }
        if (type instanceof EnumDeclaration enm) {
            for (EnumConstantDeclaration constant : enm.getEntries()) {
                String fieldKey = NaturalKeys.javaField(fqcn, constant.getNameAsString());
                collector.put(GraphNodeDraft.of(
                        GraphNodeType.FIELD,
                        fieldKey,
                        constant.getNameAsString(),
                        filePath,
                        lineStart(constant),
                        lineEnd(constant)));
                collector.edge(typeKey, fieldKey, GraphEdgeType.DECLARES, EdgeConfidence.CONFIRMED);
            }
        }
        for (FieldDeclaration field : type.getFields()) {
            visitField(field, fqcn, typeKey, cu, pkg, filePath, collector);
        }
        for (ConstructorDeclaration ctor : type.getConstructors()) {
            visitCallable(ctor, fqcn, typeKey, cu, pkg, filePath, collector);
        }
        for (MethodDeclaration method : type.getMethods()) {
            visitCallable(method, fqcn, typeKey, cu, pkg, filePath, collector);
        }
        if (type instanceof RecordDeclaration record) {
            for (Parameter component : record.getParameters()) {
                String fieldKey = NaturalKeys.javaField(fqcn, component.getNameAsString());
                collector.put(GraphNodeDraft.of(
                        GraphNodeType.FIELD,
                        fieldKey,
                        component.getNameAsString(),
                        filePath,
                        lineStart(component),
                        lineEnd(component)));
                collector.edge(typeKey, fieldKey, GraphEdgeType.DECLARES, EdgeConfidence.CONFIRMED);
                usesType(typeKey, JavaTypeNames.resolve(component.getType(), cu, pkg), filePath, collector);
            }
        }
        for (TypeDeclaration<?> nested : nestedTypes(type)) {
            visitTypeMembers(cu, nested, fqcn, filePath, collector);
        }
    }

    private void visitTypeCalls(
            CompilationUnit cu, TypeDeclaration<?> type, String pkg, String filePath, Collector collector) {
        String fqcn = fqcn(pkg, type);
        for (ConstructorDeclaration ctor : type.getConstructors()) {
            visitCallableCalls(ctor, fqcn, cu, pkg, filePath, collector);
        }
        for (MethodDeclaration method : type.getMethods()) {
            visitCallableCalls(method, fqcn, cu, pkg, filePath, collector);
        }
        for (TypeDeclaration<?> nested : nestedTypes(type)) {
            visitTypeCalls(cu, nested, fqcn, filePath, collector);
        }
    }

    private List<TypeDeclaration<?>> nestedTypes(TypeDeclaration<?> type) {
        List<TypeDeclaration<?>> nested = new ArrayList<>();
        for (var member : type.getMembers()) {
            if (member instanceof TypeDeclaration<?> nestedType) {
                nested.add(nestedType);
            }
        }
        return nested;
    }

    private void visitHeritage(
            ClassOrInterfaceDeclaration type,
            String typeKey,
            CompilationUnit cu,
            String pkg,
            String filePath,
            Collector collector) {
        for (ClassOrInterfaceType ext : type.getExtendedTypes()) {
            String target = JavaTypeNames.resolve(ext, cu, pkg);
            GraphNodeType targetKind = type.isInterface() ? GraphNodeType.INTERFACE : GraphNodeType.CLASS;
            ensureType(target, targetKind, filePath, collector);
            collector.edge(typeKey, NaturalKeys.javaType(target), GraphEdgeType.EXTENDS, EdgeConfidence.CONFIRMED);
            usesType(typeKey, target, filePath, collector);
        }
        for (ClassOrInterfaceType impl : type.getImplementedTypes()) {
            String target = JavaTypeNames.resolve(impl, cu, pkg);
            ensureType(target, GraphNodeType.INTERFACE, filePath, collector);
            collector.edge(typeKey, NaturalKeys.javaType(target), GraphEdgeType.IMPLEMENTS, EdgeConfidence.CONFIRMED);
            usesType(typeKey, target, filePath, collector);
        }
    }

    private void visitImports(CompilationUnit cu, String typeKey, Collector collector) {
        for (ImportDeclaration imp : cu.getImports()) {
            if (imp.isAsterisk() || imp.isStatic()) {
                continue;
            }
            String imported = imp.getNameAsString();
            if (collector.hasType(imported)) {
                collector.edge(
                        typeKey, NaturalKeys.javaType(imported), GraphEdgeType.IMPORTS, EdgeConfidence.CONFIRMED);
            }
        }
    }

    private void visitField(
            FieldDeclaration field,
            String ownerFqcn,
            String ownerKey,
            CompilationUnit cu,
            String pkg,
            String filePath,
            Collector collector) {
        String typeName = JavaTypeNames.resolve(field.getCommonType(), cu, pkg);
        for (VariableDeclarator variable : field.getVariables()) {
            String fieldKey = NaturalKeys.javaField(ownerFqcn, variable.getNameAsString());
            collector.put(GraphNodeDraft.of(
                    GraphNodeType.FIELD,
                    fieldKey,
                    variable.getNameAsString(),
                    filePath,
                    lineStart(variable),
                    lineEnd(variable)));
            collector.edge(ownerKey, fieldKey, GraphEdgeType.DECLARES, EdgeConfidence.CONFIRMED);
            annotate(field, fieldKey, cu, pkg, filePath, collector);
            usesType(fieldKey, typeName, filePath, collector);
            usesType(ownerKey, typeName, filePath, collector);
        }
    }

    private void visitCallable(
            CallableDeclaration<?> callable,
            String ownerFqcn,
            String ownerKey,
            CompilationUnit cu,
            String pkg,
            String filePath,
            Collector collector) {
        String methodName = callable.getNameAsString();
        List<String> params = parameterTypes(callable, cu, pkg);
        String methodKey = NaturalKeys.javaMethod(ownerFqcn, methodName, params);
        collector.put(GraphNodeDraft.of(
                GraphNodeType.METHOD, methodKey, methodName, filePath, lineStart(callable), lineEnd(callable)));
        collector.projectMethods.put(methodKey, methodName);
        collector.edge(ownerKey, methodKey, GraphEdgeType.DECLARES, EdgeConfidence.CONFIRMED);
        collector.evidences.add(declarationEvidence(methodKey, filePath, callable));
        annotate(callable, methodKey, cu, pkg, filePath, collector);
        if (callable instanceof MethodDeclaration method && !method.getType().isVoidType()) {
            usesType(methodKey, JavaTypeNames.resolve(method.getType(), cu, pkg), filePath, collector);
        }
        for (Parameter parameter : callable.getParameters()) {
            annotate(parameter, methodKey, cu, pkg, filePath, collector);
            usesType(methodKey, JavaTypeNames.resolve(parameter.getType(), cu, pkg), filePath, collector);
        }
        callable.findAll(ObjectCreationExpr.class).forEach(creation -> {
            try {
                String created = JavaTypeNames.resolve(creation.getType(), cu, pkg);
                usesType(methodKey, created, filePath, collector);
            } catch (RuntimeException ignored) {
                // Keep analyzing remaining expressions.
            }
        });
    }

    private void visitCallableCalls(
            CallableDeclaration<?> callable,
            String ownerFqcn,
            CompilationUnit cu,
            String pkg,
            String filePath,
            Collector collector) {
        List<String> params = parameterTypes(callable, cu, pkg);
        String methodKey = NaturalKeys.javaMethod(ownerFqcn, callable.getNameAsString(), params);
        callable.findAll(MethodCallExpr.class)
                .forEach(call -> visitCall(call, methodKey, ownerFqcn, cu, pkg, filePath, collector));
    }

    private void visitCall(
            MethodCallExpr call,
            String callerKey,
            String enclosingFqcn,
            CompilationUnit cu,
            String pkg,
            String filePath,
            Collector collector) {
        Optional<ResolvedMethodDeclaration> resolved = resolveMethod(call);
        if (resolved.isPresent() && isProjectSource(resolved.get(), collector)) {
            ResolvedMethodDeclaration method = resolved.get();
            String targetFqcn = method.declaringType().getQualifiedName();
            String targetKey = NaturalKeys.javaMethod(targetFqcn, method.getName(), resolvedParams(method));
            ensureMethod(
                    targetFqcn,
                    method.getName(),
                    resolvedParams(method),
                    collector.projectTypes.contains(targetFqcn) ? filePathOf(method, filePath) : null,
                    Map.of(),
                    collector);
            collector.edge(callerKey, targetKey, GraphEdgeType.CALLS, EdgeConfidence.CONFIRMED);
            return;
        }
        String methodName = call.getNameAsString();
        List<String> argTypes = argumentTypes(call, cu, pkg);
        Optional<String> receiver = receiverType(call, enclosingFqcn, cu, pkg);
        if (receiver.isPresent() && collector.projectTypes.contains(receiver.get())) {
            String targetFqcn = receiver.get();
            String targetKey = NaturalKeys.javaMethod(targetFqcn, methodName, argTypes);
            Map<String, Object> metadata = new LinkedHashMap<>();
            metadata.put("candidateSignatures", List.of(signature(targetFqcn, methodName, argTypes)));
            metadata.put("resolution", "unresolved");
            ensureMethod(
                    targetFqcn,
                    methodName,
                    argTypes,
                    ownerFile(targetFqcn, filePath, collector),
                    Map.of("inherited", true),
                    collector);
            collector.edge(callerKey, targetKey, GraphEdgeType.CALLS, EdgeConfidence.POSSIBLE, metadata);
            return;
        }
        List<String> candidates = collector.projectMethods.entrySet().stream()
                .filter(entry -> entry.getValue().equals(methodName))
                .map(Map.Entry::getKey)
                .toList();
        if (candidates.isEmpty()) {
            return;
        }
        Map<String, Object> metadata = Map.of("candidateSignatures", candidates);
        for (String candidate : candidates) {
            collector.edge(callerKey, candidate, GraphEdgeType.CALLS, EdgeConfidence.POSSIBLE, metadata);
        }
    }

    private List<String> parameterTypes(CallableDeclaration<?> callable, CompilationUnit cu, String pkg) {
        List<String> types = new ArrayList<>();
        for (Parameter parameter : callable.getParameters()) {
            String resolved = JavaTypeNames.resolve(parameter.getType(), cu, pkg);
            if (parameter.isVarArgs() && !resolved.endsWith("[]")) {
                resolved = resolved + "[]";
            }
            types.add(resolved);
        }
        return types;
    }

    private List<String> resolvedParams(ResolvedMethodDeclaration method) {
        List<String> types = new ArrayList<>();
        for (int i = 0; i < method.getNumberOfParams(); i++) {
            try {
                types.add(JavaTypeNames.describe(method.getParam(i).getType()));
            } catch (RuntimeException e) {
                types.add("java.lang.Object");
            }
        }
        return types;
    }

    private List<String> argumentTypes(MethodCallExpr call, CompilationUnit cu, String pkg) {
        List<String> types = new ArrayList<>();
        for (Expression arg : call.getArguments()) {
            try {
                types.add(JavaTypeNames.describe(arg.calculateResolvedType()));
            } catch (RuntimeException e) {
                types.add("java.lang.Object");
            }
        }
        return types;
    }

    private Optional<String> receiverType(MethodCallExpr call, String enclosingFqcn, CompilationUnit cu, String pkg) {
        if (call.getScope().isEmpty()) {
            return Optional.of(enclosingFqcn);
        }
        Expression scope = call.getScope().get();
        try {
            ResolvedType type = scope.calculateResolvedType();
            if (type.isReferenceType()) {
                return Optional.of(type.asReferenceType().getQualifiedName());
            }
        } catch (RuntimeException ignored) {
            // Fall through to AST name qualification.
        }
        return Optional.of(JavaTypeNames.qualify(scope.toString(), cu, pkg));
    }

    private Optional<ResolvedMethodDeclaration> resolveMethod(MethodCallExpr call) {
        try {
            return Optional.of(call.resolve());
        } catch (UnsolvedSymbolException | UnsupportedOperationException | IllegalStateException e) {
            return Optional.empty();
        } catch (RuntimeException e) {
            return Optional.empty();
        }
    }

    private boolean isProjectSource(ResolvedMethodDeclaration method, Collector collector) {
        try {
            String declaring = method.declaringType().getQualifiedName();
            if (!collector.projectTypes.contains(declaring)) {
                return false;
            }
            Optional<Node> ast = method.toAst();
            return ast.isPresent();
        } catch (RuntimeException e) {
            return false;
        }
    }

    private String filePathOf(ResolvedMethodDeclaration method, String fallback) {
        try {
            return method.toAst()
                    .flatMap(Node::findCompilationUnit)
                    .flatMap(CompilationUnit::getStorage)
                    .map(storage -> storage.getPath().toString().replace('\\', '/'))
                    .map(path -> {
                        int idx = path.indexOf("/src/");
                        return idx >= 0 ? path.substring(idx + 1) : fallback;
                    })
                    .orElse(fallback);
        } catch (RuntimeException e) {
            return fallback;
        }
    }

    private String ownerFile(String fqcn, String fallback, Collector collector) {
        GraphNodeDraft existing = collector.nodes.get(NaturalKeys.javaType(fqcn));
        return existing != null && existing.filePath() != null ? existing.filePath() : fallback;
    }

    private void annotate(
            NodeWithAnnotations<?> annotated,
            String subjectKey,
            CompilationUnit cu,
            String pkg,
            String filePath,
            Collector collector) {
        for (AnnotationExpr annotation : annotated.getAnnotations()) {
            String fqcn = resolveAnnotation(annotation, cu, pkg);
            ensureType(fqcn, GraphNodeType.ANNOTATION, null, collector);
            collector.edge(
                    subjectKey, NaturalKeys.javaType(fqcn), GraphEdgeType.ANNOTATED_BY, EdgeConfidence.CONFIRMED);
        }
    }

    private String resolveAnnotation(AnnotationExpr annotation, CompilationUnit cu, String pkg) {
        try {
            ResolvedReferenceTypeDeclaration resolved = annotation.resolve();
            return resolved.getQualifiedName();
        } catch (RuntimeException e) {
            return JavaTypeNames.qualify(annotation.getNameAsString(), cu, pkg);
        }
    }

    private void usesType(String sourceKey, String typeFqcn, String filePath, Collector collector) {
        if (typeFqcn == null || isPrimitiveOrVoid(typeFqcn) || typeFqcn.startsWith("?")) {
            return;
        }
        String stripped = typeFqcn.replace("[]", "");
        if (!collector.hasType(stripped) && !collector.projectTypes.contains(stripped)) {
            return;
        }
        if (!collector.hasType(stripped)) {
            return;
        }
        collector.edge(sourceKey, NaturalKeys.javaType(stripped), GraphEdgeType.USES_TYPE, EdgeConfidence.CONFIRMED);
    }

    private void ensureType(String fqcn, GraphNodeType kind, String filePath, Collector collector) {
        String key = NaturalKeys.javaType(fqcn);
        if (collector.nodes.containsKey(key)) {
            return;
        }
        boolean project = collector.projectTypes.contains(fqcn);
        collector.put(
                GraphNodeDraft.of(kind, key, JavaTypeNames.simpleName(fqcn), project ? filePath : null, null, null)
                        .withMetadata(project ? Map.of() : Map.of("external", true)));
    }

    private void ensureMethod(
            String ownerFqcn,
            String methodName,
            List<String> params,
            String filePath,
            Map<String, Object> metadata,
            Collector collector) {
        ensureType(
                ownerFqcn,
                collector.projectTypes.contains(ownerFqcn) ? GraphNodeType.CLASS : GraphNodeType.INTERFACE,
                filePath,
                collector);
        String key = NaturalKeys.javaMethod(ownerFqcn, methodName, params);
        if (!collector.nodes.containsKey(key)) {
            collector.put(GraphNodeDraft.of(GraphNodeType.METHOD, key, methodName, filePath, null, null)
                    .withMetadata(metadata));
        }
        collector.edge(NaturalKeys.javaType(ownerFqcn), key, GraphEdgeType.DECLARES, EdgeConfidence.CONFIRMED);
        collector.projectMethods.putIfAbsent(key, methodName);
    }

    private GraphNodeType nodeTypeOf(TypeDeclaration<?> type) {
        if (type instanceof AnnotationDeclaration) {
            return GraphNodeType.ANNOTATION;
        }
        if (type instanceof EnumDeclaration) {
            return GraphNodeType.ENUM;
        }
        if (type instanceof ClassOrInterfaceDeclaration coi && coi.isInterface()) {
            return GraphNodeType.INTERFACE;
        }
        return GraphNodeType.CLASS;
    }

    private String fqcn(String pkg, TypeDeclaration<?> type) {
        String name = type.getFullyQualifiedName().orElseGet(() -> {
            if (pkg == null || pkg.isBlank()) {
                return type.getNameAsString();
            }
            return pkg + "." + type.getNameAsString();
        });
        return name;
    }

    private Integer lineStart(Node node) {
        return node.getBegin().map(pos -> pos.line).orElse(null);
    }

    private Integer lineEnd(Node node) {
        return node.getEnd().map(pos -> pos.line).orElse(null);
    }

    private AnalyzerEvidence declarationEvidence(String naturalKey, String filePath, Node node) {
        String excerpt = node.toString().strip();
        int nl = excerpt.indexOf('\n');
        if (nl >= 0) {
            excerpt = excerpt.substring(0, nl).strip();
        }
        if (excerpt.length() > EXCERPT_LEN) {
            excerpt = excerpt.substring(0, EXCERPT_LEN);
        }
        return new AnalyzerEvidence(
                naturalKey, EvidenceKind.FILE_LINE, filePath, lineStart(node), lineEnd(node), excerpt);
    }

    private AnalyzerEvidence parseFailure(InventoriedFile file, Exception e, Path clonePath) {
        String message = sanitize(e.getMessage() == null ? e.toString() : e.getMessage(), clonePath);
        if (message.length() > 240) {
            message = message.substring(0, 240);
        }
        return new AnalyzerEvidence(null, EvidenceKind.FILE_LINE, file.path(), 1, 1, "Parse failed: " + message);
    }

    private String sanitize(String message, Path clonePath) {
        if (message == null) {
            return "parse failed";
        }
        String sanitized = message.replace('\n', ' ');
        if (clonePath != null) {
            sanitized = sanitized.replace(clonePath.toAbsolutePath().normalize().toString(), "");
        }
        return sanitized.strip();
    }

    private boolean isPrimitiveOrVoid(String type) {
        String stripped = type.replace("[]", "");
        return switch (stripped) {
            case "void", "boolean", "byte", "short", "int", "long", "char", "float", "double" -> true;
            default -> false;
        };
    }

    private static String signature(String fqcn, String method, List<String> params) {
        return fqcn + "#" + method + "(" + String.join(",", params) + ")";
    }

    private static final class Collector {
        private final Map<String, GraphNodeDraft> nodes = new LinkedHashMap<>();
        private final List<GraphEdgeDraft> edges = new ArrayList<>();
        private final List<AnalyzerEvidence> evidences = new ArrayList<>();
        private final Set<String> projectTypes = new java.util.LinkedHashSet<>();
        private final Map<String, String> projectMethods = new LinkedHashMap<>();

        void put(GraphNodeDraft node) {
            GraphNodeDraft existing = nodes.get(node.naturalKey());
            if (existing == null || isRicher(node, existing)) {
                nodes.put(node.naturalKey(), node);
            }
        }

        private static boolean isRicher(GraphNodeDraft candidate, GraphNodeDraft existing) {
            boolean candidateSourced = candidate.filePath() != null && candidate.lineStart() != null;
            boolean existingSourced = existing.filePath() != null && existing.lineStart() != null;
            return candidateSourced && !existingSourced;
        }

        boolean hasType(String fqcn) {
            return nodes.containsKey(NaturalKeys.javaType(fqcn));
        }

        void edge(String source, String target, GraphEdgeType type, EdgeConfidence confidence) {
            edge(source, target, type, confidence, Map.of());
        }

        void edge(
                String source,
                String target,
                GraphEdgeType type,
                EdgeConfidence confidence,
                Map<String, Object> metadata) {
            if (source == null || target == null || source.equals(target)) {
                return;
            }
            edges.add(GraphEdgeDraft.of(source, target, type, confidence).withMetadata(metadata));
        }

        AnalysisResult toResult() {
            return new AnalysisResult(List.copyOf(nodes.values()), List.copyOf(edges), List.copyOf(evidences));
        }
    }

    private record ParsedUnit(InventoriedFile file, CompilationUnit cu, String pkg) {}
}
