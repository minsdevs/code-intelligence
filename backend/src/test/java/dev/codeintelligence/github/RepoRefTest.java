package dev.codeintelligence.github;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

class RepoRefTest {

    @Test
    void acceptsValidOwnerAndName() {
        RepoRef ref = RepoRef.of("octo-cat_1", "my.repo-name");
        assertThat(ref.owner()).isEqualTo("octo-cat_1");
        assertThat(ref.name()).isEqualTo("my.repo-name");
        assertThat(ref.cloneUrl("https://github.com")).isEqualTo("https://github.com/octo-cat_1/my.repo-name.git");
    }

    @ParameterizedTest
    @CsvSource({
        "https://github.com/octocat/demo, octocat, demo",
        "https://github.com/octocat/demo.git, octocat, demo",
        "https://github.com/octocat/demo/, octocat, demo",
        "https://github.com/oc-to.cat_x/de_mo.x, oc-to.cat_x, de_mo.x"
    })
    void acceptsGithubUrls(String url, String owner, String name) {
        RepoRef ref = RepoRef.fromUrl(url);
        assertThat(ref.owner()).isEqualTo(owner);
        assertThat(ref.name()).isEqualTo(name);
    }

    @ParameterizedTest
    @ValueSource(strings = {"../x", "..", "a..b", "/etc/passwd", "a/b", "owner name", "own$er", ""})
    void rejectsPoisonedSegments(String value) {
        assertThatThrownBy(() -> RepoRef.of(value, "demo")).isInstanceOf(InvalidRepoInputException.class);
        assertThatThrownBy(() -> RepoRef.of("octocat", value)).isInstanceOf(InvalidRepoInputException.class);
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "https://evil.com/octocat/demo",
                "https://github.com.evil.com/octocat/demo",
                "http://github.com/octocat/demo",
                "git@github.com:octocat/demo.git",
                "ssh://git@github.com/octocat/demo.git",
                "file:///etc/passwd",
                "https://github.com/octocat",
                "https://github.com/octocat/demo/extra",
                "https://github.com/../demo",
                "https://user@github.com/octocat/demo",
                "/tmp/absolute/path"
            })
    void rejectsNonGithubUrls(String url) {
        assertThatThrownBy(() -> RepoRef.fromUrl(url)).isInstanceOf(InvalidRepoInputException.class);
    }

    @Test
    void errorDetailNeverEchoesTheInput() {
        assertThatThrownBy(() -> RepoRef.fromUrl("https://evil.com/secret-path"))
                .isInstanceOf(InvalidRepoInputException.class)
                .satisfies(e -> assertThat(
                                ((InvalidRepoInputException) e).getBody().getDetail())
                        .doesNotContain("evil.com")
                        .doesNotContain("secret-path"));
    }
}
