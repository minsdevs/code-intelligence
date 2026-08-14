package dev.codeintelligence.note;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class NoteReferenceParser {

    public enum SubjectType {
        FILE,
        NODE,
        COMMIT,
        TASK,
        NOTE
    }

    public record ParsedRef(SubjectType type, String rawTarget, String label) {}

    private static final Pattern FILE = Pattern.compile("@file(?::|\\s+)(\\S+)");
    private static final Pattern CLASS_METHOD = Pattern.compile("@class#([A-Za-z0-9_]+)");
    private static final Pattern CLASS = Pattern.compile("@class(?::|\\s+)([A-Za-z0-9_#]+)");
    private static final Pattern COMMIT = Pattern.compile("@commit(?::|\\s+)([a-fA-F0-9]{7,40})");
    private static final Pattern TASK = Pattern.compile("@task(?::|\\s+)(\\d+)");
    private static final Pattern WIKI = Pattern.compile("\\[\\[([^\\]]+)\\]\\]");

    private NoteReferenceParser() {}

    public static List<ParsedRef> parse(String markdown) {
        if (markdown == null || markdown.isBlank()) {
            return List.of();
        }
        List<ParsedRef> refs = new ArrayList<>();
        addAll(refs, FILE.matcher(markdown), SubjectType.FILE);
        addClass(refs, markdown);
        addAll(refs, COMMIT.matcher(markdown), SubjectType.COMMIT);
        addAll(refs, TASK.matcher(markdown), SubjectType.TASK);
        Matcher wiki = WIKI.matcher(markdown);
        while (wiki.find()) {
            String title = wiki.group(1).strip();
            if (!title.isBlank()) {
                refs.add(new ParsedRef(SubjectType.NOTE, title, title));
            }
        }
        return List.copyOf(refs);
    }

    private static void addAll(List<ParsedRef> refs, Matcher matcher, SubjectType type) {
        while (matcher.find()) {
            String target = matcher.group(1).strip();
            refs.add(new ParsedRef(type, target, target));
        }
    }

    private static void addClass(List<ParsedRef> refs, String markdown) {
        Matcher method = CLASS_METHOD.matcher(markdown);
        while (method.find()) {
            String name = method.group(1);
            refs.add(new ParsedRef(SubjectType.NODE, name, name));
        }
        Matcher classRef = CLASS.matcher(markdown);
        while (classRef.find()) {
            String name = classRef.group(1);
            refs.add(new ParsedRef(SubjectType.NODE, name, name));
        }
    }
}
