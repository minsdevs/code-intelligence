package dev.codeintelligence.analysis.core;

import java.util.regex.Pattern;

public final class PathGlobs {

    private PathGlobs() {}

    public static boolean matches(String path, String pattern) {
        if (path == null || pattern == null) {
            return false;
        }
        return Pattern.compile(toRegex(pattern))
                .matcher(path.replace('\\', '/'))
                .matches();
    }

    static String toRegex(String pattern) {
        StringBuilder regex = new StringBuilder("^");
        for (int i = 0; i < pattern.length(); i++) {
            char c = pattern.charAt(i);
            if (c == '*' && i + 1 < pattern.length() && pattern.charAt(i + 1) == '*') {
                if (i + 2 < pattern.length() && pattern.charAt(i + 2) == '/') {
                    regex.append("(?:.*/)?");
                    i += 2;
                } else {
                    regex.append(".*");
                    i++;
                }
            } else if (c == '*') {
                regex.append("[^/]*");
            } else if (".[](){}+^$|\\".indexOf(c) >= 0) {
                regex.append('\\').append(c);
            } else {
                regex.append(c);
            }
        }
        return regex.append('$').toString();
    }
}
