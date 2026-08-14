package dev.codeintelligence.analysis.java;

import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.ImportDeclaration;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import com.github.javaparser.ast.type.Type;
import com.github.javaparser.resolution.UnsolvedSymbolException;
import com.github.javaparser.resolution.types.ResolvedType;
import java.util.Locale;
import java.util.Optional;

final class JavaTypeNames {

    private JavaTypeNames() {}

    static String resolve(Type type, CompilationUnit cu, String currentPackage) {
        try {
            return describe(type.resolve());
        } catch (UnsolvedSymbolException | UnsupportedOperationException | IllegalStateException ignored) {
            return qualify(simpleName(type), cu, currentPackage);
        } catch (RuntimeException ignored) {
            return qualify(simpleName(type), cu, currentPackage);
        }
    }

    static String resolve(ClassOrInterfaceType type, CompilationUnit cu, String currentPackage) {
        try {
            ResolvedType resolved = type.resolve();
            if (resolved.isReferenceType()) {
                return resolved.asReferenceType().getQualifiedName();
            }
            return describe(resolved);
        } catch (UnsolvedSymbolException | UnsupportedOperationException | IllegalStateException ignored) {
            return qualify(type.getNameAsString(), cu, currentPackage);
        } catch (RuntimeException ignored) {
            return qualify(type.getNameAsString(), cu, currentPackage);
        }
    }

    static String describe(ResolvedType type) {
        if (type == null) {
            return "java.lang.Object";
        }
        if (type.isVoid()) {
            return "void";
        }
        if (type.isPrimitive()) {
            return type.asPrimitive().describe();
        }
        if (type.isArray()) {
            return describe(type.asArrayType().getComponentType()) + "[]";
        }
        if (type.isReferenceType()) {
            return type.asReferenceType().getQualifiedName();
        }
        if (type.isTypeVariable()) {
            try {
                return describe(type.asTypeVariable().erasure());
            } catch (RuntimeException e) {
                return type.describe();
            }
        }
        return type.describe();
    }

    static String qualify(String simpleOrFqcn, CompilationUnit cu, String currentPackage) {
        if (simpleOrFqcn == null || simpleOrFqcn.isBlank()) {
            return "java.lang.Object";
        }
        String trimmed = simpleOrFqcn.strip();
        if (isPrimitiveOrVoid(trimmed) || trimmed.endsWith("[]") && isPrimitiveOrVoid(trimmed.replace("[]", ""))) {
            return trimmed;
        }
        if (trimmed.contains(".")) {
            return trimmed;
        }
        Optional<String> imported = findImport(cu, trimmed);
        if (imported.isPresent()) {
            return imported.get();
        }
        if (isJavaLang(trimmed)) {
            return "java.lang." + trimmed;
        }
        if (currentPackage != null && !currentPackage.isBlank()) {
            return currentPackage + "." + trimmed;
        }
        return trimmed;
    }

    static String simpleName(String fqcn) {
        int dot = fqcn.lastIndexOf('.');
        return dot < 0 ? fqcn : fqcn.substring(dot + 1);
    }

    private static String simpleName(Type type) {
        if (type.isClassOrInterfaceType()) {
            return type.asClassOrInterfaceType().getNameAsString();
        }
        if (type.isArrayType()) {
            return simpleName(type.asArrayType().getComponentType()) + "[]";
        }
        if (type.isPrimitiveType()) {
            return type.asPrimitiveType().asString();
        }
        if (type.isVoidType()) {
            return "void";
        }
        return type.asString();
    }

    private static Optional<String> findImport(CompilationUnit cu, String simple) {
        for (ImportDeclaration imp : cu.getImports()) {
            if (imp.isAsterisk() || imp.isStatic()) {
                continue;
            }
            String name = imp.getNameAsString();
            if (name.endsWith("." + simple) || name.equals(simple)) {
                return Optional.of(name);
            }
        }
        return Optional.empty();
    }

    private static boolean isPrimitiveOrVoid(String name) {
        return switch (name) {
            case "void", "boolean", "byte", "short", "int", "long", "char", "float", "double" -> true;
            default -> false;
        };
    }

    private static boolean isJavaLang(String simple) {
        try {
            Class.forName("java.lang." + simple);
            return true;
        } catch (ClassNotFoundException e) {
            return Character.isUpperCase(simple.charAt(0)) && isWellKnownJavaLang(simple);
        }
    }

    private static boolean isWellKnownJavaLang(String simple) {
        return switch (simple.toLowerCase(Locale.ROOT)) {
            case "string",
                    "object",
                    "long",
                    "integer",
                    "boolean",
                    "double",
                    "float",
                    "short",
                    "byte",
                    "character",
                    "void",
                    "class",
                    "override",
                    "deprecated",
                    "suppresswarnings",
                    "functionalinterface",
                    "safeargs",
                    "safevarargs" -> true;
            default -> false;
        };
    }
}
