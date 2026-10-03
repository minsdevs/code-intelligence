package dev.codeintelligence.project;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** A bounded gitignore subset. No regex, configuration lookup, logging or filesystem access. */
final class LocalIgnoreRules {
    private LocalIgnoreRules() {}

    @FunctionalInterface
    interface Budget {
        void check() throws IOException;
    }

    static Rule parse(String line) throws IOException {
        if (line.isEmpty() || line.charAt(0) == '#') return null;
        boolean ignored = line.charAt(0) != '!';
        String pattern = ignored ? line : line.substring(1);
        pattern = trimTrailingSpaces(pattern);
        if (pattern.isEmpty()) return null;
        boolean directoryOnly = pattern.endsWith("/");
        if (directoryOnly) pattern = pattern.substring(0, pattern.length() - 1);
        boolean anchored = pattern.startsWith("/");
        if (anchored) pattern = pattern.substring(1);
        if (pattern.isEmpty()) return null;
        anchored |= pattern.indexOf('/') >= 0;
        List<Segment> segments = new ArrayList<>();
        for (String part : pattern.split("/", -1)) {
            if (part.isEmpty()) throw unsupported();
            if (part.equals("**")) {
                segments.add(new Segment(true, List.of()));
                continue;
            }
            List<Integer> tokens = new ArrayList<>();
            for (int i = 0; i < part.length(); i++) {
                char character = part.charAt(i);
                if (character == '\\') {
                    if (++i == part.length()) throw unsupported();
                    int literal = part.codePointAt(i);
                    addLiteral(tokens, literal);
                    i += Character.charCount(literal) - 1;
                } else if (character == '[' || character == ']') {
                    // Character classes and POSIX classes are deliberately unsupported, not ignored.
                    throw unsupported();
                } else {
                    if (character == '*') tokens.add(Segment.STAR);
                    else if (character == '?') tokens.add(Segment.ANY);
                    else {
                        int literal = part.codePointAt(i);
                        addLiteral(tokens, literal);
                        i += Character.charCount(literal) - 1;
                    }
                }
            }
            segments.add(new Segment(false, List.copyOf(tokens)));
        }
        return new Rule(List.copyOf(segments), anchored, directoryOnly, ignored);
    }

    private static void addLiteral(List<Integer> tokens, int codePoint) {
        for (byte value : new String(Character.toChars(codePoint)).getBytes(StandardCharsets.UTF_8)) {
            tokens.add(Byte.toUnsignedInt(value));
        }
    }

    private static String trimTrailingSpaces(String value) {
        int end = value.length();
        while (end > 0 && value.charAt(end - 1) == ' ') {
            int slashes = 0;
            for (int i = end - 2; i >= 0 && value.charAt(i) == '\\'; i--) slashes++;
            if (slashes % 2 == 1) break;
            end--;
        }
        return value.substring(0, end);
    }

    private static IOException unsupported() {
        return new IOException("A local ignore rule uses unsupported syntax.");
    }

    record Rule(List<Segment> segments, boolean anchored, boolean directoryOnly, boolean ignored) {
        boolean matches(String path, boolean directory, Budget budget) throws IOException {
            budget.check();
            if (directoryOnly && !directory) return false;
            String[] names = path.split("/", -1);
            if (!anchored) return segments.getFirst().matches(names[names.length - 1], budget);
            // Dynamic programming over path components: ** consumes zero or more complete names.
            boolean[] previous = new boolean[names.length + 1];
            previous[0] = true;
            for (int i = 0; i < segments.size(); i++) {
                budget.check();
                Segment segment = segments.get(i);
                boolean[] current = new boolean[names.length + 1];
                if (segment.recursive()) {
                    boolean needsChild = i == segments.size() - 1 && segments.size() > 1;
                    current[0] = !needsChild && previous[0];
                    for (int j = 1; j <= names.length; j++) {
                        budget.check();
                        current[j] = current[j - 1] || (needsChild ? previous[j - 1] : previous[j]);
                    }
                } else {
                    for (int j = 1; j <= names.length; j++) {
                        budget.check();
                        current[j] = previous[j - 1] && segment.matches(names[j - 1], budget);
                    }
                }
                previous = current;
            }
            return previous[names.length];
        }
    }

    record Segment(boolean recursive, List<Integer> tokens) {
        static final int STAR = -1;
        static final int ANY = -2;

        boolean matches(String name, Budget budget) throws IOException {
            if (recursive) return true;
            // Git wildmatch operates on UTF-8 bytes: '?' consumes one byte, not a Java char.
            // Every token/name-byte pair is visited once; repeated '*' never causes backtracking.
            byte[] bytes = name.getBytes(StandardCharsets.UTF_8);
            boolean[] previous = new boolean[bytes.length + 1];
            previous[0] = true;
            for (int token : tokens) {
                budget.check();
                boolean[] current = new boolean[bytes.length + 1];
                current[0] = token == STAR && previous[0];
                for (int i = 1; i <= bytes.length; i++) {
                    if ((i & 31) == 0) budget.check();
                    current[i] = token == STAR
                            ? current[i - 1] || previous[i]
                            : previous[i - 1] && (token == ANY || token == Byte.toUnsignedInt(bytes[i - 1]));
                }
                previous = current;
            }
            return previous[bytes.length];
        }
    }
}
