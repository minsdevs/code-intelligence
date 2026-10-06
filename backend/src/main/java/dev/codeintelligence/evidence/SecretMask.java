package dev.codeintelligence.evidence;

import java.util.List;
import java.util.regex.Pattern;

/** Redacts credential-like material before evidence excerpts are persisted. */
public final class SecretMask {

    private static final String REDACTED = "[REDACTED]";
    private static final List<Pattern> PATTERNS = List.of(
            // Mask the body as well as the marker, including a context window cut mid-key.
            Pattern.compile("(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|\\z)"),
            Pattern.compile("(?i)github_pat_[A-Za-z0-9_]{20,}"),
            Pattern.compile("(?i)(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}"),
            Pattern.compile("AKIA[0-9A-Z]{16}"),
            Pattern.compile("(?i)bearer\\s+[A-Za-z0-9._\\-+/=]{8,}"),
            Pattern.compile("(?i)((?:password|secret|token|api[_-]?key)[\"']?\\s*[:=]\\s*)"
                    + "(?:\"(?:\\\\.|[^\"\\\\])*(?:\"|\\z)|'(?:\\\\.|[^'\\\\])*(?:'|\\z)|[^\\s,;}]+)"),
            Pattern.compile("(?i)sk-[A-Za-z0-9_-]{20,}"),
            Pattern.compile("AIza[0-9A-Za-z_-]{20,}"),
            // Password in connection-URI userinfo (scheme://user:password@host); user and host stay readable.
            Pattern.compile("(?i)(\\b[a-z][a-z0-9+.-]{0,31}://[^\\s:/?#@'\"`]{0,256}:)[^\\s/?#@'\"`]{1,256}(?=@)"));

    private SecretMask() {}

    public static String redact(String excerpt) {
        if (excerpt == null || excerpt.isBlank()) {
            return excerpt;
        }
        String masked = excerpt;
        for (Pattern pattern : PATTERNS) {
            masked = pattern.matcher(masked).replaceAll(match -> {
                if (match.groupCount() >= 1 && match.group(1) != null) {
                    return match.group(1) + REDACTED;
                }
                return REDACTED;
            });
        }
        return masked;
    }
}
