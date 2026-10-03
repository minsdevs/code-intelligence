package dev.codeintelligence.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertTimeout;

import java.io.IOException;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

class LocalIgnoreRulesTest {
    @ParameterizedTest
    @CsvSource({
        "*.log, child/app.log, false, true", "*.log, app.txt, false, false",
        "/app.log, child/app.log, false, false", "/app.log, app.log, false, true",
        "build/, child/build, true, true", "build/, child/build, false, false",
        "a/**/b.txt, a/b.txt, false, true", "a/**/b.txt, a/x/y/b.txt, false, true",
        "a/**/b.txt, other/a/b.txt, false, false", "a/**, a, true, false",
        "a/**, a/x, false, true", "**/b.txt, b.txt, false, true",
        "**/b.txt, a/b.txt, false, true", "**/a/**/b.txt, x/a/y/z/b.txt, false, true",
        "a?c.txt, abc.txt, false, true", "a?c.txt, abbc.txt, false, false",
        "\\#literal, #literal, false, true", "\\!literal, !literal, false, true",
        "!keep.log, keep.log, false, true", "a*b*c, abbbc, false, true",
        "a*b*c, abbbx, false, false"
    })
    void supportedRulesHavePredictableMatching(String rule, String path, boolean directory, boolean expected)
            throws Exception {
        assertThat(LocalIgnoreRules.parse(rule).matches(path, directory, () -> {}))
                .isEqualTo(expected);
    }

    @Test
    void leadingEscapesAndNegationDoNotReclassifyComments() throws Exception {
        assertThat(LocalIgnoreRules.parse("# comment")).isNull();
        assertThat(LocalIgnoreRules.parse("\\#literal").ignored()).isTrue();
        assertThat(LocalIgnoreRules.parse("!keep.log").ignored()).isFalse();
        assertThat(LocalIgnoreRules.parse("!#literal").ignored()).isFalse();
        assertThat(LocalIgnoreRules.parse("name   ").matches("name", false, () -> {}))
                .isTrue();
        assertThat(LocalIgnoreRules.parse("name\\ ").matches("name ", false, () -> {}))
                .isTrue();
    }

    @ParameterizedTest
    @CsvSource({
        "???.txt, 한.txt, true", "?.txt, 한.txt, false",
        "????.txt, 😀.txt, true", "??.txt, 😀.txt, false",
        "??.txt, é.txt, true", "?.txt, é.txt, false",
        "한?.txt, 한a.txt, true", "한?.txt, 한é.txt, false",
        "é???.txt, é한.txt, true", "😀?.txt, 😀a.txt, true",
        "\\한?.txt, 한a.txt, true", "*/???.txt, nested/한.txt, true",
        "**/????.txt, nested/deep/😀.txt, true", "한/**/??.txt, 한/nested/é.txt, true"
    })
    void wildcardsAndLiteralsUseUtf8BytesLikeGit(String rule, String path, boolean expected) throws Exception {
        assertThat(LocalIgnoreRules.parse(rule).matches(path, false, () -> {})).isEqualTo(expected);
    }

    @ParameterizedTest
    @ValueSource(strings = {"[abc]", "[unterminated", "\\#[unterminated", "a//b", "trailing\\"})
    void unsupportedRulesFailWithoutIncludingThePatternInTheError(String rule) {
        assertThatThrownBy(() -> LocalIgnoreRules.parse(rule))
                .isInstanceOf(IOException.class)
                .hasMessage("A local ignore rule uses unsupported syntax.");
    }

    @Test
    void repeatedStarsHavePolynomialCostAndChecksRunInsideMatching() throws Exception {
        var rule = LocalIgnoreRules.parse("*a".repeat(20) + "b");
        AtomicInteger checks = new AtomicInteger();
        assertTimeout(
                Duration.ofSeconds(1),
                () -> assertThat(rule.matches("a".repeat(100), false, checks::incrementAndGet))
                        .isFalse());
        assertThat(checks.get()).isGreaterThan(40);
        checks.set(0);
        assertThatThrownBy(() -> rule.matches("a".repeat(100), false, () -> {
                    if (checks.incrementAndGet() > 5) throw new IOException("budget exhausted");
                }))
                .isInstanceOf(IOException.class)
                .hasMessage("budget exhausted");
    }
}
