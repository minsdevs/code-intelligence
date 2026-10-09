package dev.codeintelligence.analysis.java;

import com.github.javaparser.JavaParser;
import com.github.javaparser.ParseResult;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.nodeTypes.NodeWithAnnotations;
import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.InventoriedFile;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Iterator;
import java.util.Locale;
import java.util.NoSuchElementException;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Lightweight JavaParser (no SymbolSolver) for Spring/JPA annotation walks. */
final class JavaParseSupport {

    private static final Logger log = LoggerFactory.getLogger(JavaParseSupport.class);
    static final java.util.concurrent.atomic.AtomicLong PARSER_INVOCATIONS =
            new java.util.concurrent.atomic.AtomicLong();

    private JavaParseSupport() {}

    static ParseAhead<InventoriedFile, ParsedJavaFile> parseAhead(
            AnalysisContext context, java.util.List<InventoriedFile> files) {
        return new ParseAhead<>(files, JavaParseSupport::parser, (parser, file) -> parse(context, parser, file));
    }

    /**
     * Parses lazily and in order, a few files ahead on helper threads ({@link ParseAhead}), so a
     * caller holds a bounded number of syntax trees instead of the whole project's (heap and
     * resident memory then do not grow with the project).
     */
    static Iterable<ParsedJavaFile> parseJavaFiles(AnalysisContext ctx) {
        return () -> new Iterator<>() {
            private final ParseAhead<InventoriedFile, ParsedJavaFile> parses = parseAhead(
                    ctx,
                    ctx.inventory().files().stream()
                            .filter(JavaParseSupport::isJava)
                            .toList());
            private ParsedJavaFile next;

            @Override
            public boolean hasNext() {
                while (next == null && parses.hasNext()) {
                    next = parses.next().value();
                }
                if (next == null) parses.close();
                return next != null;
            }

            @Override
            public ParsedJavaFile next() {
                if (!hasNext()) {
                    throw new NoSuchElementException();
                }
                ParsedJavaFile unit = next;
                next = null;
                return unit;
            }
        };
    }

    private static ParsedJavaFile parse(AnalysisContext ctx, JavaParser parser, InventoriedFile file) {
        if (!isJava(file)) {
            return null;
        }
        Path absolute = ctx.clonePath().resolve(file.path()).normalize();
        if (!Files.isRegularFile(absolute)) {
            return null;
        }
        try {
            PARSER_INVOCATIONS.incrementAndGet();
            ParseResult<CompilationUnit> parsed = parser.parse(absolute);
            if (!parsed.isSuccessful() || parsed.getResult().isEmpty()) {
                return null;
            }
            CompilationUnit cu = parsed.getResult().get();
            String pkg = cu.getPackageDeclaration()
                    .map(decl -> decl.getNameAsString())
                    .orElse("");
            return new ParsedJavaFile(file, cu, pkg);
        } catch (Exception e) {
            log.warn("Skipping Java file {}: {}", file.path(), e.toString());
            return null;
        }
    }

    static boolean isJava(InventoriedFile file) {
        return "java".equalsIgnoreCase(file.language())
                || file.path().toLowerCase(Locale.ROOT).endsWith(".java");
    }

    static String fqcn(String pkg, TypeDeclaration<?> type) {
        return type.getFullyQualifiedName().orElseGet(() -> {
            if (pkg == null || pkg.isBlank()) {
                return type.getNameAsString();
            }
            return pkg + "." + type.getNameAsString();
        });
    }

    static Integer lineStart(com.github.javaparser.ast.Node node) {
        return node.getBegin().map(pos -> pos.line).orElse(null);
    }

    static Integer lineEnd(com.github.javaparser.ast.Node node) {
        return node.getEnd().map(pos -> pos.line).orElse(null);
    }

    static String simpleName(AnnotationExpr annotation) {
        return annotation.getName().getIdentifier();
    }

    static boolean hasAnnotation(NodeWithAnnotations<?> node, String... simpleNames) {
        return findAnnotation(node, simpleNames).isPresent();
    }

    static Optional<AnnotationExpr> findAnnotation(NodeWithAnnotations<?> node, String... simpleNames) {
        for (AnnotationExpr annotation : node.getAnnotations()) {
            String simple = simpleName(annotation);
            for (String expected : simpleNames) {
                if (expected.equals(simple)) {
                    return Optional.of(annotation);
                }
            }
        }
        return Optional.empty();
    }

    static String excerpt(com.github.javaparser.ast.Node node) {
        String text = node.toString().strip();
        int nl = text.indexOf('\n');
        if (nl >= 0) {
            text = text.substring(0, nl).strip();
        }
        if (text.length() > 80) {
            return text.substring(0, 80);
        }
        return text;
    }

    private static JavaParser parser() {
        ParserConfiguration configuration = new ParserConfiguration();
        configuration.setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_21);
        return new JavaParser(configuration);
    }

    record ParsedJavaFile(InventoriedFile file, CompilationUnit cu, String pkg) {}
}
