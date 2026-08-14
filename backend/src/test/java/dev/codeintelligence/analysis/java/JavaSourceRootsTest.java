package dev.codeintelligence.analysis.java;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class JavaSourceRootsTest {

    @TempDir
    Path temp;

    @Test
    void findsStandardAndInferredRoots() throws Exception {
        Path clone = temp.resolve("repo");
        Path mainRoot = clone.resolve("src/main/java");
        Path testRoot = clone.resolve("src/test/java");
        Path customRoot = clone.resolve("modules/example/src");
        Path plainRoot = clone.resolve("scripts");

        write(mainRoot.resolve("com/example/Main.java"), "package com.example;\nclass Main {}\n");
        Files.createDirectories(testRoot);
        write(customRoot.resolve("com/example/Custom.JAVA"), "package com.example;\nclass Custom {}\n");
        write(plainRoot.resolve("Plain.java"), "class Plain {}\n");

        Set<Path> roots = JavaSourceRoots.find(clone);

        assertThat(roots).containsExactlyInAnyOrder(mainRoot, testRoot, customRoot, plainRoot);
        List<Path> orderedRoots = List.copyOf(roots);
        assertThat(orderedRoots.subList(0, 2)).containsExactlyInAnyOrder(mainRoot, testRoot);
        assertThat(orderedRoots.subList(2, 4)).containsExactlyInAnyOrder(customRoot, plainRoot);
    }

    @Test
    void ignoresJavaFilesWhosePackageDoesNotMatchTheirPath() throws Exception {
        Path clone = temp.resolve("repo");
        Path misplaced = clone.resolve("src/com/example/Misplaced.java");
        write(misplaced, "package other.example;\nclass Misplaced {}\n");

        assertThat(JavaSourceRoots.find(clone)).isEmpty();
    }

    @Test
    void returnsEmptyForNullAndNonDirectoryPaths() throws Exception {
        Path file = temp.resolve("file.txt");
        Files.writeString(file, "not a directory");

        assertThat(JavaSourceRoots.find(null)).isEmpty();
        assertThat(JavaSourceRoots.find(temp.resolve("missing"))).isEmpty();
        assertThat(JavaSourceRoots.find(file)).isEmpty();
    }

    private static void write(Path file, String source) throws Exception {
        Files.createDirectories(file.getParent());
        Files.writeString(file, source);
    }
}
