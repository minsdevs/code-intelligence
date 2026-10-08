package dev.codeintelligence.analysis.java;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/** Infers JavaParser source roots and project type FQCNs from the clone tree (read-only). */
final class JavaSourceRoots {

    private static final Pattern PACKAGE_DECL = Pattern.compile("^\\s*package\\s+([\\w.]+)\\s*;", Pattern.MULTILINE);
    private static final int PEEK_BYTES = 4096;

    private JavaSourceRoots() {}

    static Set<Path> find(Path clonePath) {
        Set<Path> roots = new LinkedHashSet<>();
        if (clonePath == null || !Files.isDirectory(clonePath)) {
            return roots;
        }
        Path normalized = clonePath.toAbsolutePath().normalize();
        Set<Path> inferredRoots = new LinkedHashSet<>();
        try (Stream<Path> walk = Files.walk(normalized)) {
            walk.filter(path -> !dev.codeintelligence.analysis.core.AnalysisInputFingerprint.isMetadata(normalized.relativize(path))).forEach(path -> {
                if (Files.isDirectory(path) && isStandardSourceRoot(path)) {
                    roots.add(path.toAbsolutePath().normalize());
                }

                if (Files.isRegularFile(path)
                        && path.getFileName()
                                .toString()
                                .toLowerCase(Locale.ROOT)
                                .endsWith(".java")) {
                    Path root = inferRoot(normalized, path);
                    if (root != null) {
                        inferredRoots.add(root);
                    }
                }
            });
        } catch (IOException ignored) {
            // Skip unreadable paths.
        }
        roots.addAll(inferredRoots);
        return roots;
    }

    static Set<String> projectTypes(Set<Path> sourceRoots) {
        Set<String> types = new LinkedHashSet<>();
        for (Path root : sourceRoots) {
            if (!Files.isDirectory(root)) {
                continue;
            }
            try (Stream<Path> walk = Files.walk(root)) {
                walk.filter(path -> !dev.codeintelligence.analysis.core.AnalysisInputFingerprint.isMetadata(root.relativize(path)))
                        .filter(Files::isRegularFile)
                        .filter(path -> path.getFileName().toString().endsWith(".java"))
                        .forEach(javaFile -> {
                            String rel = root.relativize(javaFile).toString().replace('\\', '/');
                            if (rel.endsWith(".java") && !rel.contains("module-info")) {
                                types.add(rel.substring(0, rel.length() - 5).replace('/', '.'));
                            }
                        });
            } catch (IOException ignored) {
                // Skip unreadable roots.
            }
        }
        return types;
    }

    private static boolean isStandardSourceRoot(Path dir) {
        Path normalized = dir.normalize();
        return normalized.endsWith(Path.of("src", "main", "java"))
                || normalized.endsWith(Path.of("src", "test", "java"));
    }

    private static Path inferRoot(Path clonePath, Path javaFile) {
        String pkg = peekPackage(javaFile);
        Path parent = javaFile.getParent();
        if (parent == null) {
            return null;
        }
        if (pkg == null || pkg.isBlank()) {
            Path candidate = parent.toAbsolutePath().normalize();
            return candidate.startsWith(clonePath) ? candidate : null;
        }
        Path packagePath = Path.of("", pkg.split("\\."));
        if (!parent.endsWith(packagePath)) {
            return null;
        }
        Path root = parent;
        for (int i = 0; i < packagePath.getNameCount(); i++) {
            root = root.getParent();
            if (root == null) {
                return null;
            }
        }
        Path normalized = root.toAbsolutePath().normalize();
        return normalized.startsWith(clonePath) ? normalized : null;
    }

    private static String peekPackage(Path javaFile) {
        try (var input = Files.newInputStream(javaFile)) {
            byte[] bytes = input.readNBytes(PEEK_BYTES);
            String head = new String(bytes, StandardCharsets.UTF_8);
            Matcher matcher = PACKAGE_DECL.matcher(head);
            return matcher.find() ? matcher.group(1) : null;
        } catch (IOException e) {
            return null;
        }
    }
}
