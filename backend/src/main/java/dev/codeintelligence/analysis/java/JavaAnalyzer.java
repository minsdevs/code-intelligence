package dev.codeintelligence.analysis.java;

import com.github.javaparser.JavaParser;
import com.github.javaparser.JavaToken;
import com.github.javaparser.ParseResult;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.AccessSpecifier;
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
import com.github.javaparser.ast.nodeTypes.NodeWithImplements;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import com.github.javaparser.resolution.UnsolvedSymbolException;
import com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration;
import com.github.javaparser.resolution.declarations.ResolvedReferenceTypeDeclaration;
import com.github.javaparser.resolution.model.SymbolReference;
import com.github.javaparser.resolution.types.ResolvedType;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.github.javaparser.symbolsolver.cache.GuavaCache;
import com.github.javaparser.symbolsolver.javaparsermodel.JavaParserFacade;
import com.github.javaparser.symbolsolver.resolution.typesolvers.CombinedTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.JavaParserTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.ReflectionTypeSolver;
import com.google.common.cache.CacheBuilder;
import com.google.common.cache.Weigher;
import dev.codeintelligence.analysis.core.AnalysisCacheWeight;
import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisInputFingerprint;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.AnalyzerEvidence;
import dev.codeintelligence.analysis.core.CodeAnalyzer;
import dev.codeintelligence.analysis.core.EdgeConfidence;
import dev.codeintelligence.analysis.core.FileAnalysisOutcome;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphEdgeDraft;
import dev.codeintelligence.analysis.core.GraphEdgeType;
import dev.codeintelligence.analysis.core.GraphIdentityGuard;
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
 * CONFIRMED, except virtual calls on an interface or abstract receiver, which become CALLS/POSSIBLE
 * to their class-hierarchy implementation candidates. Every CALLS edge carries its call site.
 */
@Component
public class JavaAnalyzer implements CodeAnalyzer {

    private static final Logger log = LoggerFactory.getLogger(JavaAnalyzer.class);
    private static final int EXCERPT_LEN = 80;
    /** Candidate sets above this size are not published as candidates (T00 candidate contract). */
    private static final int MAX_CANDIDATES = 5;
    /**
     * Syntax trees each symbol solver cache may pin (unsolved names and missing files weigh
     * nothing). The solver's default caches are unbounded: every solved type pins the tree that
     * declares it, and a name that is not a project type (String, a library annotation) parses
     * every file of the package it is looked up from, so one solver held a second tree of nearly
     * every project file. Evicted trees are parsed again on their next use.
     */
    static final int SOLVER_CACHED_TREES = 128;

    private String completedKey;
    private AnalysisResult completedResult;
    private Map<String, FilePhases> phases = Map.of();
    private long cachedProject = Long.MIN_VALUE;
    private final java.util.concurrent.atomic.AtomicInteger parses = new java.util.concurrent.atomic.AtomicInteger();
    private int reusedPhases;
    private long retainedBytes;
    static final long MAX_CACHE_BYTES = 256L * 1024 * 1024;
    private final long cacheBudget;
    private final java.util.concurrent.locks.ReentrantLock analysisLock =
            new java.util.concurrent.locks.ReentrantLock();

    public JavaAnalyzer() {
        this(MAX_CACHE_BYTES);
    }

    JavaAnalyzer(long cacheBudget) {
        this.cacheBudget = Math.max(0, Math.min(MAX_CACHE_BYTES, cacheBudget));
    }

    record CacheStats(int parserInvocations, int reusedPhases, int files, long retainedBytes) {}

    CacheStats cacheStats() {
        lockAnalysis();
        try {
            return new CacheStats(parses.get(), reusedPhases, phases.size(), retainedBytes);
        } finally {
            analysisLock.unlock();
        }
    }

    private void lockAnalysis() {
        try {
            analysisLock.lockInterruptibly();
        } catch (InterruptedException cancelled) {
            Thread.currentThread().interrupt();
            throw new dev.codeintelligence.job.JobCancelledException();
        }
    }

    private record Tape(String context, List<Event> events) {
        void replay(Collector collector) {
            collector.replaying = true;
            try {
                for (Event event : events) event.replay(collector);
            } finally {
                collector.replaying = false;
            }
        }
    }

    private record FilePhases(String blob, String declarations, Tape types, Tape members, Tape calls) {}

    private Map<String, FilePhases> analyzeIncrementally(
            AnalysisContext ctx,
            ParserConfiguration configuration,
            Collector collector,
            AnalysisInputFingerprint.Snapshot input) {
        List<InventoriedFile> files =
                ctx.inventory().files().stream().filter(JavaAnalyzer::isJava).toList();
        Map<String, FilePhases> next = new LinkedHashMap<>();
        List<InventoriedFile> changed = files.stream()
                .filter(file -> reusable(file, input, ctx.projectId()) == null)
                .toList();
        configuration.setStoreTokens(true);
        try (ParseAhead<InventoriedFile, ParsedUnit> units = parseAhead(ctx, configuration, changed)) {
            for (InventoriedFile file : files) {
                AnalysisInputFingerprint.checkpoint();
                FilePhases previous = reusable(file, input, ctx.projectId());
                if (previous != null) {
                    previous.types.replay(collector);
                    reusedPhases++;
                    next.put(file.path(), previous);
                    continue;
                }
                ParsedUnit unit;
                try {
                    unit = units.next().get();
                } catch (Exception failure) {
                    collector.evidence(parseFailure(file, failure, ctx.clonePath()));
                    collector.outcomes.put(
                            file.path(), new FileAnalysisOutcome(file.path(), "FAILED", "JAVA_PARSE_FAILED"));
                    continue;
                }
                collector.recording = new ArrayList<>();
                registerTypes(unit, collector);
                Tape types = finishTape(collector, "");
                String blob = input == null ? null : input.files().get(file.path());
                next.put(file.path(), new FilePhases(blob, declarations(unit.cu), types, null, null));
            }
        }
        java.security.MessageDigest global = AnalysisInputFingerprint.digest();
        AnalysisInputFingerprint.update(global, input == null ? "unknown" : input.environment());
        if (!collector.outcomes.isEmpty() && input != null) AnalysisInputFingerprint.update(global, input.complete());
        AnalysisInputFingerprint.update(global, collector.projectTypes.toString());
        for (var entry : next.entrySet()) {
            AnalysisInputFingerprint.update(global, entry.getKey());
            AnalysisInputFingerprint.update(global, entry.getValue().declarations);
        }
        String dependencies = java.util.HexFormat.of().formatHex(global.digest());
        for (int phase = 1; phase <= 2; phase++) {
            configuration.setStoreTokens(true);
            // Resolution is sequential: earlier files may introduce fallback symbols. The tape key
            // includes that exact prefix context as well as every declaration/configuration dependency.
            JavaParser parser = new JavaParser(configuration);
            Set<String> scheduled = new java.util.HashSet<>();
            List<InventoriedFile> missing = new ArrayList<>();
            for (InventoriedFile file : files) {
                FilePhases entry = next.get(file.path());
                if (entry == null) continue;
                Tape previous = phase == 1 ? entry.members : entry.calls;
                if (input == null || previous == null || !previous.context.startsWith(dependencies)) {
                    missing.add(file);
                    scheduled.add(file.path());
                }
            }
            try (ParseAhead<InventoriedFile, ParsedUnit> ahead = parseAhead(ctx, configuration, missing)) {
                for (InventoriedFile file : files) {
                    AnalysisInputFingerprint.checkpoint();
                    FilePhases entry = next.get(file.path());
                    if (entry == null) continue;
                    String context = dependencies + collector.contextKey();
                    Tape tape = phase == 1 ? entry.members : entry.calls;
                    if (input != null && tape != null && tape.context.equals(context)) {
                        tape.replay(collector);
                        reusedPhases++;
                    } else {
                        ParsedUnit unit =
                                scheduled.contains(file.path()) ? reparsed(ahead.next()) : parseFile(ctx, parser, file);
                        collector.recording = new ArrayList<>();
                        if (phase == 1) visitMembers(unit, collector);
                        else visitCalls(unit, collector);
                        tape = finishTape(collector, context);
                    }
                    next.put(
                            file.path(),
                            phase == 1
                                    ? new FilePhases(entry.blob, entry.declarations, entry.types, tape, entry.calls)
                                    : new FilePhases(entry.blob, entry.declarations, entry.types, entry.members, tape));
                    if (phase == 2)
                        collector.outcomes.put(
                                file.path(),
                                new FileAnalysisOutcome(
                                        file.path(),
                                        collector.unresolvedFiles.contains(file.path()) ? "PARTIAL" : "SUCCESS",
                                        collector.unresolvedFiles.contains(file.path())
                                                ? "UNRESOLVED_CALLS"
                                                : "JAVA_PARSED"));
                }
            }
        }
        return next;
    }

    private FilePhases reusable(InventoriedFile file, AnalysisInputFingerprint.Snapshot input, long project) {
        if (input == null || project != cachedProject) return null;
        FilePhases entry = phases.get(file.path());
        return entry != null
                        && entry.blob != null
                        && entry.blob.equals(input.files().get(file.path()))
                ? entry
                : null;
    }

    private static Tape finishTape(Collector collector, String context) {
        Tape tape = new Tape(context, List.copyOf(collector.recording));
        collector.recording = null;
        return tape;
    }

    private static String declarations(CompilationUnit unit) {
        CompilationUnit declaration = unit.clone();
        declaration.findAll(MethodDeclaration.class).forEach(method -> {
            if (method.getBody().isPresent()) method.setBody(new com.github.javaparser.ast.stmt.BlockStmt());
        });
        declaration
                .findAll(ConstructorDeclaration.class)
                .forEach(constructor -> constructor.setBody(new com.github.javaparser.ast.stmt.BlockStmt()));
        declaration
                .findAll(FieldDeclaration.class)
                .forEach(field -> field.getVariables().forEach(variable -> {
                    // Explicit field types determine external resolution; inferred/anonymous declarations
                    // retain their initializer as a conservative dependency.
                    if (!variable.getType().isVarType()
                            && variable.getInitializer().stream()
                                    .flatMap(value -> value.findAll(ObjectCreationExpr.class).stream())
                                    .noneMatch(value ->
                                            value.getAnonymousClassBody().isPresent())) variable.removeInitializer();
                }));
        declaration
                .findAll(com.github.javaparser.ast.body.InitializerDeclaration.class)
                .forEach(initializer -> initializer.setBody(new com.github.javaparser.ast.stmt.BlockStmt()));
        declaration.getAllContainedComments().forEach(comment -> comment.remove());
        declaration.removeComment();
        return AnalysisInputFingerprint.hash(declaration.toString());
    }

    private void retain(Map<String, FilePhases> next, boolean known) {
        if (!known) {
            phases = Map.of();
            retainedBytes = 0;
            return;
        }
        Map<String, FilePhases> bounded = new LinkedHashMap<>();
        long bytes = 0;
        for (var entry : next.entrySet()) {
            AnalysisInputFingerprint.checkpoint();
            AnalysisCacheWeight.Counter weightCounter = new AnalysisCacheWeight.Counter();
            FilePhases file = entry.getValue();
            long weight = 512L
                    + weightCounter.of(entry.getKey())
                    + weightCounter.of(file.blob)
                    + weightCounter.of(file.declarations);
            for (Tape tape : List.of(file.types, file.members, file.calls)) {
                weight += 96L + weightCounter.of(tape.context) + 8L * tape.events.size();
                for (Event event : tape.events) weight += event.weight(weightCounter);
            }
            if (weight > cacheBudget - bytes) continue;
            bounded.put(entry.getKey(), entry.getValue());
            bytes += weight;
        }
        phases = Map.copyOf(bounded);
        retainedBytes = bytes;
    }

    @Override
    public boolean supports(FileInventory inventory) {
        return inventory.hasLanguage("java")
                || inventory.files().stream()
                        .anyMatch(file -> file.path().toLowerCase(Locale.ROOT).endsWith(".java"));
    }

    @Override
    public AnalysisResult analyze(AnalysisContext ctx) {
        return analyze(ctx, AnalysisInputFingerprint.capture(ctx));
    }

    public AnalysisResult analyze(AnalysisContext ctx, AnalysisInputFingerprint.Snapshot input) {
        lockAnalysis();
        try {
            return analyzeLocked(ctx, input);
        } finally {
            analysisLock.unlock();
        }
    }

    private AnalysisResult analyzeLocked(AnalysisContext ctx, AnalysisInputFingerprint.Snapshot input) {
        AnalysisInputFingerprint.checkpoint();
        parses.set(0);
        reusedPhases = 0;
        String key = input == null ? null : input.complete();
        if (key != null && key.equals(completedKey)) {
            log.info("Java incremental reuse: parsed=0, completedHit=true, retainedBytes={}", retainedBytes);
            return completedResult;
        }
        Collector collector = new Collector();
        Set<Path> sourceRoots = JavaSourceRoots.find(ctx.clonePath());
        collector.projectTypes.addAll(JavaSourceRoots.projectTypes(sourceRoots));
        // Only immutable phase events survive a refresh; syntax trees stay bounded to a parse pass.
        ParserConfiguration configuration = createConfiguration(sourceRoots);
        Map<String, FilePhases> next;
        try {
            next = analyzeIncrementally(ctx, configuration, collector, input);
        } finally {
            releaseFacades();
        }
        AnalysisResult result = collector.toResult();
        AnalysisInputFingerprint.checkpoint();
        retain(next, input != null);
        cachedProject = ctx.projectId();
        long completedWeight =
                key != null && phases.size() == next.size() ? AnalysisCacheWeight.of(result) : Long.MAX_VALUE;
        if (completedWeight <= cacheBudget - retainedBytes) {
            completedKey = key;
            completedResult = result;
            retainedBytes += completedWeight;
        } else {
            completedKey = null;
            completedResult = null;
        }
        log.info(
                "Java incremental reuse: parsed={}, reusedPhases={}, retainedBytes={}",
                parses.get(),
                reusedPhases,
                retainedBytes);
        return result;
    }

    /** Parses ahead on helper threads (parsing is most of this analyzer's time); visits stay in order here. */
    private ParseAhead<InventoriedFile, ParsedUnit> parseAhead(
            AnalysisContext ctx, ParserConfiguration configuration, List<InventoriedFile> files) {
        return new ParseAhead<>(
                files, () -> new JavaParser(configuration), (parser, file) -> parseFile(ctx, parser, file));
    }

    private static boolean isJava(InventoriedFile file) {
        return "java".equalsIgnoreCase(file.language())
                || file.path().toLowerCase(Locale.ROOT).endsWith(".java");
    }

    private static ParserConfiguration createConfiguration(Set<Path> sourceRoots) {
        CombinedTypeSolver typeSolver = new CombinedTypeSolver(
                CombinedTypeSolver.ExceptionHandlers.IGNORE_NONE, List.of(), cache(JavaAnalyzer::solvedTrees));
        for (Path root : sourceRoots) {
            if (Files.isDirectory(root)) {
                // The solver only reads declarations from its own trees; without their token lists
                // (call-site spans come from the analyzer's trees) each parse allocates and keeps less.
                typeSolver.add(new JavaParserTypeSolver(
                        root,
                        new JavaParser(new ParserConfiguration().setStoreTokens(false)),
                        cache((Path file, Optional<CompilationUnit> tree) -> tree.isPresent() ? 1 : 0),
                        cache((Path directory, List<CompilationUnit> trees) -> trees.size()),
                        cache(JavaAnalyzer::solvedTrees)));
            }
        }
        typeSolver.add(new ReflectionTypeSolver(true));
        ParserConfiguration configuration = new ParserConfiguration();
        configuration.setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_21);
        configuration.setSymbolResolver(new JavaSymbolSolver(typeSolver));
        return configuration;
    }

    /** Like the solver's own size-limited caches (softly held values, least recently used evicted), by weight. */
    private static <K, V> GuavaCache<K, V> cache(Weigher<K, V> trees) {
        // One segment: Guava splits the weight budget per segment, so a large package would never fit.
        return GuavaCache.create(CacheBuilder.newBuilder()
                .concurrencyLevel(1)
                .softValues()
                .maximumWeight(SOLVER_CACHED_TREES)
                .weigher(trees)
                .build());
    }

    private static int solvedTrees(String name, SymbolReference<ResolvedReferenceTypeDeclaration> type) {
        return type.isSolved() ? 1 : 0;
    }

    /**
     * JavaParserFacade keeps a facade per type solver in a static WeakHashMap whose values reference
     * their keys, so each analysis' solver and its caches would stay reachable after it returns.
     * Facades hold no results of their own; another running analysis just gets a new one.
     */
    private static void releaseFacades() {
        synchronized (JavaParserFacade.class) {
            JavaParserFacade.clearInstances();
        }
    }

    /** A later pass over a file that parsed in the first pass; the analysis workspace is read-only. */
    private static ParsedUnit reparsed(ParseAhead.Result<InventoriedFile, ParsedUnit> result) {
        try {
            return result.get();
        } catch (Exception e) {
            throw new IllegalStateException(
                    "Java source changed during analysis: " + result.file().path(), e);
        }
    }

    private ParsedUnit parseFile(AnalysisContext ctx, JavaParser parser, InventoriedFile file) {
        parses.incrementAndGet();
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
        collector.projectType(fqcn);
        if (type instanceof ClassOrInterfaceDeclaration coi && (coi.isInterface() || coi.isAbstract())) {
            collector.virtualType(fqcn);
        }
        String typeKey = NaturalKeys.javaType(fqcn);
        collector.put(GraphNodeDraft.of(
                nodeTypeOf(type), typeKey, type.getNameAsString(), filePath, lineStart(type), lineEnd(type)));
        collector.evidence(declarationEvidence(typeKey, filePath, type));
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
            visitHeritage(coi, fqcn, cu, pkg, filePath, collector);
        } else if (type instanceof NodeWithImplements<?> implementing) {
            // Records and enums dispatch interface calls too; record them for class-hierarchy candidates.
            for (ClassOrInterfaceType impl : implementing.getImplementedTypes()) {
                collector.supertype(fqcn, JavaTypeNames.resolve(impl, cu, pkg));
            }
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
            String fqcn,
            CompilationUnit cu,
            String pkg,
            String filePath,
            Collector collector) {
        String typeKey = NaturalKeys.javaType(fqcn);
        for (ClassOrInterfaceType ext : type.getExtendedTypes()) {
            String target = JavaTypeNames.resolve(ext, cu, pkg);
            collector.supertype(fqcn, target);
            GraphNodeType targetKind = type.isInterface() ? GraphNodeType.INTERFACE : GraphNodeType.CLASS;
            ensureType(target, targetKind, filePath, collector);
            collector.edge(typeKey, NaturalKeys.javaType(target), GraphEdgeType.EXTENDS, EdgeConfidence.CONFIRMED);
            usesType(typeKey, target, filePath, collector);
        }
        for (ClassOrInterfaceType impl : type.getImplementedTypes()) {
            String target = JavaTypeNames.resolve(impl, cu, pkg);
            collector.supertype(fqcn, target);
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
        collector.projectMethod(methodKey, methodName);
        if (callable instanceof MethodDeclaration method
                && !method.isStatic()
                && method.getBody().isPresent()) {
            collector.concreteMethod(ownerFqcn, new DeclaredMethod(methodKey, methodName, params));
        }
        collector.edge(ownerKey, methodKey, GraphEdgeType.DECLARES, EdgeConfidence.CONFIRMED);
        collector.evidence(declarationEvidence(methodKey, filePath, callable));
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
        Map<String, Object> site = callSite(call, filePath);
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
            Optional<String> virtualReceiver = virtualReceiver(call, method, enclosingFqcn, cu, pkg, collector);
            if (virtualReceiver.isPresent()) {
                publishDispatchCandidates(
                        callerKey,
                        targetKey,
                        dispatchTargets(virtualReceiver.get(), method.getName(), resolvedParams(method), collector),
                        site,
                        collector);
                return;
            }
            collector.edge(callerKey, targetKey, GraphEdgeType.CALLS, EdgeConfidence.CONFIRMED, site);
            return;
        }
        collector.unresolved(filePath);
        String methodName = call.getNameAsString();
        List<String> argTypes = argumentTypes(call, cu, pkg);
        Optional<String> receiver = receiverType(call, enclosingFqcn, cu, pkg);
        if (receiver.isPresent() && collector.projectTypes.contains(receiver.get())) {
            String targetFqcn = receiver.get();
            String targetKey = NaturalKeys.javaMethod(targetFqcn, methodName, argTypes);
            Map<String, Object> metadata = new LinkedHashMap<>(site);
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
        List<String> candidates = List.copyOf(collector.projectMethodsByName.getOrDefault(methodName, Set.of()));
        if (candidates.isEmpty()) {
            return;
        }
        Map<String, Object> metadata = new LinkedHashMap<>(site);
        metadata.put("candidateSignatures", candidates);
        for (String candidate : candidates) {
            collector.edge(callerKey, candidate, GraphEdgeType.CALLS, EdgeConfidence.POSSIBLE, metadata);
        }
    }

    /** Call-site evidence: the call's lines and its callee text exactly as written (scope through name). */
    private Map<String, Object> callSite(MethodCallExpr call, String filePath) {
        Map<String, Object> site = new LinkedHashMap<>();
        site.put("filePath", filePath);
        call.getBegin().ifPresent(position -> site.put("lineStart", position.line));
        call.getEnd().ifPresent(position -> site.put("lineEnd", position.line));
        calleeText(call).ifPresent(text -> site.put("expression", text));
        return site;
    }

    private Optional<String> calleeText(MethodCallExpr call) {
        Optional<JavaToken> last = call.getName().getTokenRange().map(range -> range.getEnd());
        if (call.getTokenRange().isEmpty() || last.isEmpty()) {
            return Optional.empty();
        }
        StringBuilder text = new StringBuilder();
        for (JavaToken token = call.getTokenRange().get().getBegin();
                token != null;
                token = token.getNextToken().orElse(null)) {
            text.append(token.getText());
            if (token == last.get()) {
                return Optional.of(text.toString());
            }
        }
        return Optional.empty();
    }

    /**
     * The receiver's static type when the call dispatches virtually on an interface or abstract class. Static,
     * private, final and super calls, and calls on a concrete receiver, bind statically.
     */
    private Optional<String> virtualReceiver(
            MethodCallExpr call,
            ResolvedMethodDeclaration method,
            String enclosingFqcn,
            CompilationUnit cu,
            String pkg,
            Collector collector) {
        try {
            if (method.isStatic()
                    || method.accessSpecifier() == AccessSpecifier.PRIVATE
                    || call.getScope().filter(Expression::isSuperExpr).isPresent()
                    || method.toAst()
                            .filter(ast -> ast instanceof MethodDeclaration declaration && declaration.isFinal())
                            .isPresent()) {
                return Optional.empty();
            }
        } catch (RuntimeException e) {
            return Optional.empty();
        }
        return receiverType(call, enclosingFqcn, cu, pkg).filter(collector.virtualTypes::contains);
    }

    /** Class-hierarchy candidates: concrete overrides in the receiver and its project subtypes, in source order. */
    private List<String> dispatchTargets(String receiver, String name, List<String> params, Collector collector) {
        List<String> targets = new ArrayList<>();
        for (var owner : collector.concreteMethods.entrySet()) {
            if (!isSubtype(owner.getKey(), receiver, collector)) {
                continue;
            }
            List<DeclaredMethod> sameArity = owner.getValue().stream()
                    .filter(method ->
                            method.name().equals(name) && method.params().size() == params.size())
                    .toList();
            List<DeclaredMethod> exact = sameArity.stream()
                    .filter(method -> method.params().equals(params))
                    .toList();
            (exact.isEmpty() ? sameArity : exact).forEach(method -> targets.add(method.key()));
        }
        return targets;
    }

    private boolean isSubtype(String type, String receiver, Collector collector) {
        Set<String> seen = new java.util.HashSet<>();
        List<String> pending = new ArrayList<>(List.of(type));
        while (!pending.isEmpty()) {
            String current = pending.removeLast();
            if (current.equals(receiver)) {
                return true;
            }
            if (seen.add(current)) {
                pending.addAll(collector.supertypes.getOrDefault(current, Set.of()));
            }
        }
        return false;
    }

    private void publishDispatchCandidates(
            String callerKey,
            String declaredKey,
            List<String> candidates,
            Map<String, Object> site,
            Collector collector) {
        Map<String, Object> metadata = new LinkedHashMap<>(site);
        metadata.put("resolution", "inferred");
        metadata.put("declaredTarget", declaredKey);
        if (candidates.isEmpty() || candidates.size() > MAX_CANDIDATES) {
            // No publishable implementation set: keep the declared method as the only, inferred, target.
            metadata.put("targetCandidates", List.of());
            metadata.put("candidateCount", candidates.size());
            collector.edge(callerKey, declaredKey, GraphEdgeType.CALLS, EdgeConfidence.POSSIBLE, metadata);
            return;
        }
        metadata.put("targetCandidates", List.copyOf(candidates));
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
        collector.projectMethod(key, methodName);
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
        private final List<GraphNodeDraft> identityCandidates = new ArrayList<>();
        private final List<GraphEdgeDraft> edges = new ArrayList<>();
        private final List<AnalyzerEvidence> evidences = new ArrayList<>();
        private final Map<String, FileAnalysisOutcome> outcomes = new LinkedHashMap<>();
        private final Set<String> unresolvedFiles = new java.util.HashSet<>();
        private final Set<String> projectTypes = new java.util.LinkedHashSet<>();
        /**
         * Project method keys by method name, in first-declaration order. Unresolved calls look their
         * name up here; scanning every project method per call was quadratic (G-PERF medium).
         */
        private final Map<String, Set<String>> projectMethodsByName = new java.util.HashMap<>();
        /** Interfaces and abstract classes declared in project source. */
        private final Set<String> virtualTypes = new java.util.HashSet<>();
        /** Direct extends/implements targets of each project type. */
        private final Map<String, Set<String>> supertypes = new LinkedHashMap<>();
        /** Instance methods with a body (including interface defaults), by declaring project type. */
        private final Map<String, List<DeclaredMethod>> concreteMethods = new LinkedHashMap<>();

        private final java.security.MessageDigest context = AnalysisInputFingerprint.digest();
        private List<Event> recording;
        private boolean replaying;

        void record(EventKind kind, Object value, Object other) {
            if (replaying) return;
            Event event = new Event(kind, value, other);
            if (recording != null) recording.add(event);
            if (kind.affectsResolution) AnalysisInputFingerprint.update(context, event.semantic());
        }

        String contextKey() {
            try {
                return java.util.HexFormat.of().formatHex(((java.security.MessageDigest) context.clone()).digest());
            } catch (CloneNotSupportedException impossible) {
                throw new IllegalStateException(impossible);
            }
        }

        void projectType(String type) {
            record(EventKind.PROJECT_TYPE, type, null);
            projectTypes.add(type);
        }

        void virtualType(String type) {
            record(EventKind.VIRTUAL_TYPE, type, null);
            virtualTypes.add(type);
        }

        void supertype(String type, String parent) {
            record(EventKind.SUPERTYPE, type, parent);
            supertypes
                    .computeIfAbsent(type, ignored -> new java.util.LinkedHashSet<>())
                    .add(parent);
        }

        void concreteMethod(String owner, DeclaredMethod method) {
            record(EventKind.CONCRETE_METHOD, owner, method);
            concreteMethods.computeIfAbsent(owner, ignored -> new ArrayList<>()).add(method);
        }

        void evidence(AnalyzerEvidence evidence) {
            record(EventKind.EVIDENCE, evidence, null);
            evidences.add(evidence);
        }

        void unresolved(String file) {
            record(EventKind.UNRESOLVED, file, null);
            unresolvedFiles.add(file);
        }

        void edgeDraft(GraphEdgeDraft edge) {
            record(EventKind.EDGE, edge, null);
            edges.add(edge);
        }

        void put(GraphNodeDraft node) {
            record(EventKind.NODE, node, null);
            GraphNodeDraft existing = nodes.get(node.naturalKey());
            if (existing != null
                    && !"PACKAGE".equals(node.nodeType())
                    && existing.filePath() != null
                    && node.filePath() != null
                    && existing.lineStart() != null
                    && node.lineStart() != null
                    && !existing.filePath().equals(node.filePath())) identityCandidates.add(node);
            if (existing == null || isRicher(node, existing)) {
                nodes.put(node.naturalKey(), node);
            }
        }

        private static boolean isRicher(GraphNodeDraft candidate, GraphNodeDraft existing) {
            boolean candidateSourced = candidate.filePath() != null && candidate.lineStart() != null;
            boolean existingSourced = existing.filePath() != null && existing.lineStart() != null;
            return candidateSourced && !existingSourced;
        }

        void projectMethod(String key, String name) {
            if (projectMethodsByName.getOrDefault(name, Set.of()).contains(key)) return;
            record(EventKind.PROJECT_METHOD, key, name);
            projectMethodsByName
                    .computeIfAbsent(name, ignored -> new java.util.LinkedHashSet<>())
                    .add(key);
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
            edgeDraft(GraphEdgeDraft.of(source, target, type, confidence).withMetadata(metadata));
        }

        AnalysisResult toResult() {
            List<GraphNodeDraft> all = new ArrayList<>(nodes.values());
            all.addAll(identityCandidates);
            return GraphIdentityGuard.sanitize(new AnalysisResult(
                    all, List.copyOf(edges), List.copyOf(evidences), List.copyOf(outcomes.values())));
        }
    }

    private enum EventKind {
        PROJECT_TYPE(true),
        VIRTUAL_TYPE(true),
        SUPERTYPE(true),
        CONCRETE_METHOD(true),
        EVIDENCE(false),
        UNRESOLVED(false),
        NODE(true),
        PROJECT_METHOD(true),
        EDGE(false);
        final boolean affectsResolution;

        EventKind(boolean affectsResolution) {
            this.affectsResolution = affectsResolution;
        }
    }

    private record Event(EventKind kind, Object value, Object other) {
        long weight(AnalysisCacheWeight.Counter counter) {
            long additional = other instanceof DeclaredMethod method
                    ? 96 + counter.of(method.key) + counter.of(method.name) + counter.of(method.params)
                    : counter.of(other);
            return 64 + counter.of(value) + additional;
        }

        String semantic() {
            if (value instanceof GraphNodeDraft node)
                return kind + ":" + node.nodeType() + ":" + node.naturalKey() + ":" + node.filePath() + ":"
                        + (node.lineStart() != null);
            return kind + ":" + value + ":" + other;
        }

        void replay(Collector collector) {
            if (kind.affectsResolution) AnalysisInputFingerprint.update(collector.context, semantic());
            switch (kind) {
                case PROJECT_TYPE -> collector.projectType((String) value);
                case VIRTUAL_TYPE -> collector.virtualType((String) value);
                case SUPERTYPE -> collector.supertype((String) value, (String) other);
                case CONCRETE_METHOD -> collector.concreteMethod((String) value, (DeclaredMethod) other);
                case EVIDENCE -> collector.evidence((AnalyzerEvidence) value);
                case UNRESOLVED -> collector.unresolved((String) value);
                case NODE -> collector.put((GraphNodeDraft) value);
                case PROJECT_METHOD -> collector.projectMethod((String) value, (String) other);
                case EDGE -> collector.edgeDraft((GraphEdgeDraft) value);
            }
        }
    }

    private record ParsedUnit(InventoriedFile file, CompilationUnit cu, String pkg) {}

    private record DeclaredMethod(String key, String name, List<String> params) {
        DeclaredMethod {
            params = List.copyOf(params);
        }
    }
}
