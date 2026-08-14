package dev.codeintelligence.analysis.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

class SafeRelativePathTest {

    @Test
    void rejectsDotDot() {
        assertThatThrownBy(() -> SafeRelativePath.normalize("../secret")).isInstanceOf(InvalidFilePathException.class);
        assertThatThrownBy(() -> SafeRelativePath.normalize("foo/../../etc/passwd"))
                .isInstanceOf(InvalidFilePathException.class);
    }

    @Test
    void rejectsAbsolutePaths() {
        assertThatThrownBy(() -> SafeRelativePath.normalize("/etc/passwd"))
                .isInstanceOf(InvalidFilePathException.class);
        assertThatThrownBy(() -> SafeRelativePath.normalize("C:/Windows/system.ini"))
                .isInstanceOf(InvalidFilePathException.class);
    }

    @Test
    void rejectsEncodedDotDot() {
        assertThatThrownBy(() -> SafeRelativePath.normalize("%2e%2e/secret"))
                .isInstanceOf(InvalidFilePathException.class);
        assertThatThrownBy(() -> SafeRelativePath.normalize("%2e%2e%2fsecret"))
                .isInstanceOf(InvalidFilePathException.class);
    }

    @Test
    void acceptsNestedRelativePath() {
        assertThat(SafeRelativePath.normalize("src/main/java/Foo.java")).isEqualTo("src/main/java/Foo.java");
    }
}
