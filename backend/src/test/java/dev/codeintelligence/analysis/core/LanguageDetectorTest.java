package dev.codeintelligence.analysis.core;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

class LanguageDetectorTest {

    @ParameterizedTest
    @CsvSource({
        "src/Foo.java,java",
        "src/Foo.kt,kotlin",
        "src/App.tsx,typescript",
        "src/main.ts,typescript",
        "src/index.js,javascript",
        "src/App.jsx,javascript",
        "app.py,python",
        "main.go,go",
        "V1.sql,sql",
        "app.yml,yaml",
        "app.yaml,yaml",
        "main.tf,hcl",
        "README.md,markdown",
        "pom.xml,xml",
        "build.gradle,gradle",
        "build.gradle.kts,gradle",
        "Dockerfile,dockerfile",
        "deploy.sh,shell"
    })
    void mapsKnownExtensions(String path, String language) {
        assertThat(LanguageDetector.detect(path)).isEqualTo(language);
    }

    @ParameterizedTest
    @ValueSource(strings = {"unknown.xyz", "Makefile", "LICENSE", "noext"})
    void unknownExtensionIsNull(String path) {
        assertThat(LanguageDetector.detect(path)).isNull();
    }
}
