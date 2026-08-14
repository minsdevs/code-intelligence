package dev.codeintelligence.analysis.cross;

import dev.codeintelligence.analysis.core.EdgeConfidence;
import java.util.Locale;
import java.util.regex.Pattern;

/** FE API call vs BE endpoint matching (§11.1). */
public final class EndpointPathMatcher {

    private static final Pattern TEMPLATE = Pattern.compile("\\{[^/}]+\\}|\\$\\{[^/}]+\\}|:[A-Za-z_][A-Za-z0-9_]*");

    private EndpointPathMatcher() {}

    public static EdgeConfidence match(String callMethod, String callUrl, String endpointMethod, String endpointPath) {
        if (callMethod == null || callUrl == null || endpointMethod == null || endpointPath == null) {
            return null;
        }
        if (!callMethod.trim().equalsIgnoreCase(endpointMethod.trim())) {
            return null;
        }
        String callPath = pathOnly(callUrl);
        String epPath = pathOnly(endpointPath);
        if (callPath.equals(epPath)) {
            return EdgeConfidence.CONFIRMED;
        }
        String callNorm = normalize(callPath);
        String epNorm = normalize(epPath);
        if (callNorm.equals(epNorm)) {
            return EdgeConfidence.LIKELY;
        }
        if (isSuffixMatch(callNorm, epNorm)) {
            return EdgeConfidence.POSSIBLE;
        }
        return null;
    }

    static String pathOnly(String url) {
        String trimmed = url.trim();
        int scheme = trimmed.indexOf("://");
        if (scheme >= 0) {
            int slash = trimmed.indexOf('/', scheme + 3);
            trimmed = slash < 0 ? "/" : trimmed.substring(slash);
        }
        int query = trimmed.indexOf('?');
        if (query >= 0) {
            trimmed = trimmed.substring(0, query);
        }
        if (trimmed.isEmpty()) {
            return "/";
        }
        if (!trimmed.startsWith("/")) {
            trimmed = "/" + trimmed;
        }
        if (trimmed.length() > 1 && trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }

    static String normalize(String path) {
        String replaced = TEMPLATE.matcher(path).replaceAll("{}");
        return replaced.toLowerCase(Locale.ROOT);
    }

    static boolean isSuffixMatch(String left, String right) {
        if (left.equals(right) || left.equals("/") || right.equals("/")) {
            return false;
        }
        return left.endsWith(right) || right.endsWith(left);
    }
}
