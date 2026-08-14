package dev.codeintelligence.analysis.java;

import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.ArrayInitializerExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.FieldAccessExpr;
import com.github.javaparser.ast.expr.MemberValuePair;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.NormalAnnotationExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

/**
 * Spring {@code @RequestMapping} family path/method synthesis. Paths keep path variables in
 * {@code {name}} form and collapse duplicate slashes.
 */
final class RequestMappings {

    private RequestMappings() {}

    static boolean isMappingAnnotation(String simpleName) {
        return switch (simpleName) {
            case "RequestMapping", "GetMapping", "PostMapping", "PutMapping", "DeleteMapping", "PatchMapping" -> true;
            default -> false;
        };
    }

    static List<String> httpMethods(AnnotationExpr annotation) {
        String simple = JavaParseSupport.simpleName(annotation);
        return switch (simple) {
            case "GetMapping" -> List.of("GET");
            case "PostMapping" -> List.of("POST");
            case "PutMapping" -> List.of("PUT");
            case "DeleteMapping" -> List.of("DELETE");
            case "PatchMapping" -> List.of("PATCH");
            case "RequestMapping" -> {
                List<String> fromAttr = enumNames(annotation, "method");
                yield fromAttr.isEmpty() ? List.of() : fromAttr;
            }
            default -> List.of();
        };
    }

    static List<String> paths(AnnotationExpr annotation) {
        if (annotation.isMarkerAnnotationExpr()) {
            return List.of("");
        }
        if (annotation.isSingleMemberAnnotationExpr()) {
            return stringValues(annotation.asSingleMemberAnnotationExpr().getMemberValue());
        }
        if (annotation.isNormalAnnotationExpr()) {
            Optional<Expression> value = pair(annotation.asNormalAnnotationExpr(), "path")
                    .or(() -> pair(annotation.asNormalAnnotationExpr(), "value"));
            if (value.isPresent()) {
                return stringValues(value.get());
            }
        }
        return List.of("");
    }

    static String join(String classPrefix, String methodPath) {
        String left = classPrefix == null ? "" : classPrefix.strip();
        String right = methodPath == null ? "" : methodPath.strip();
        if (!left.isEmpty() && !left.startsWith("/")) {
            left = "/" + left;
        }
        if (right.isEmpty()) {
            return normalize(left.isEmpty() ? "/" : left);
        }
        if (!right.startsWith("/")) {
            right = "/" + right;
        }
        return normalize(left + right);
    }

    static String normalize(String path) {
        String raw = path == null || path.isBlank() ? "/" : path.strip();
        StringBuilder out = new StringBuilder();
        boolean slash = false;
        for (int i = 0; i < raw.length(); i++) {
            char ch = raw.charAt(i);
            if (ch == '/') {
                if (!slash) {
                    out.append('/');
                }
                slash = true;
            } else {
                out.append(ch);
                slash = false;
            }
        }
        String normalized = out.toString();
        if (!normalized.startsWith("/")) {
            normalized = "/" + normalized;
        }
        if (normalized.length() > 1 && normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        return normalized;
    }

    /**
     * Default table name when {@code @Table} is absent: camelCase simple class name to snake_case
     * (Spring Boot {@code SnakeCasePhysicalNamingStrategy} on the implicit JPA name).
     * {@code OrderItem} → {@code order_item}; {@code HTTPRequest} → {@code http_request}.
     */
    static String toSnakeCase(String simpleName) {
        if (simpleName == null || simpleName.isBlank()) {
            return simpleName;
        }
        String withBoundaries =
                simpleName.replaceAll("([a-z0-9])([A-Z])", "$1_$2").replaceAll("([A-Z]+)([A-Z][a-z])", "$1_$2");
        return withBoundaries.toLowerCase(Locale.ROOT);
    }

    private static Optional<Expression> pair(NormalAnnotationExpr annotation, String name) {
        for (MemberValuePair pair : annotation.getPairs()) {
            if (name.equals(pair.getNameAsString())) {
                return Optional.of(pair.getValue());
            }
        }
        return Optional.empty();
    }

    private static List<String> stringValues(Expression expression) {
        if (expression instanceof StringLiteralExpr literal) {
            return List.of(literal.getValue());
        }
        if (expression instanceof ArrayInitializerExpr array) {
            List<String> values = new ArrayList<>();
            for (Expression element : array.getValues()) {
                values.addAll(stringValues(element));
            }
            return values.isEmpty() ? List.of("") : values;
        }
        if (expression instanceof NameExpr name) {
            return List.of(name.getNameAsString());
        }
        return List.of("");
    }

    private static List<String> enumNames(AnnotationExpr annotation, String attribute) {
        if (!annotation.isNormalAnnotationExpr()) {
            return List.of();
        }
        Optional<Expression> value = pair(annotation.asNormalAnnotationExpr(), attribute);
        if (value.isEmpty()) {
            return List.of();
        }
        return enumNames(value.get());
    }

    private static List<String> enumNames(Expression expression) {
        if (expression instanceof FieldAccessExpr field) {
            return List.of(field.getNameAsString().toUpperCase(Locale.ROOT));
        }
        if (expression instanceof NameExpr name) {
            return List.of(name.getNameAsString().toUpperCase(Locale.ROOT));
        }
        if (expression instanceof ArrayInitializerExpr array) {
            List<String> values = new ArrayList<>();
            for (Expression element : array.getValues()) {
                values.addAll(enumNames(element));
            }
            return values;
        }
        return List.of();
    }
}
