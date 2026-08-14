package dev.codeintelligence.github;

import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.util.StringUtils;

/**
 * Validated repository coordinates (§18 SSRF 방어). Owner/name only accept {@code [A-Za-z0-9_.-]+}
 * without {@code ..}; URL input accepts exactly {@code https://github.com/{owner}/{repo}}
 * (optional {@code .git} suffix and trailing slash) — every other scheme or host is a 400.
 */
public record RepoRef(String owner, String name) {

    private static final Pattern SEGMENT = Pattern.compile("[A-Za-z0-9_.-]+");
    private static final Pattern GITHUB_URL =
            Pattern.compile("^https://github\\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\\.git)?/?$");

    public static RepoRef of(String owner, String name) {
        return new RepoRef(validSegment(owner, "repoOwner"), validSegment(name, "repoName"));
    }

    public static RepoRef fromUrl(String url) {
        if (!StringUtils.hasText(url)) {
            throw new InvalidRepoInputException("url must not be blank.");
        }
        Matcher matcher = GITHUB_URL.matcher(url.strip());
        if (!matcher.matches()) {
            throw new InvalidRepoInputException("Only https://github.com/{owner}/{repo} URLs are supported.");
        }
        return of(matcher.group(1), matcher.group(2));
    }

    private static String validSegment(String value, String field) {
        if (!StringUtils.hasText(value)) {
            throw new InvalidRepoInputException(field + " must not be blank.");
        }
        String trimmed = value.strip();
        if (!SEGMENT.matcher(trimmed).matches() || trimmed.contains("..")) {
            throw new InvalidRepoInputException(field + " contains characters that are not allowed.");
        }
        return trimmed;
    }

    public String cloneUrl(String baseUrl) {
        return baseUrl + "/" + owner + "/" + name + ".git";
    }
}
