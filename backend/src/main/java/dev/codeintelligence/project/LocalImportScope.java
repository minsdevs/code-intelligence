package dev.codeintelligence.project;

import dev.codeintelligence.common.LanguageDetector;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import org.springframework.jdbc.core.simple.JdbcClient;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Optional narrowing of a local selection to top-level directories and/or languages. An empty
 * list does not filter. {@code "."} names the files directly in the root. The canonical form is
 * part of the approval binding, so the confirmed copy applies exactly the previewed scope.
 */
public record LocalImportScope(List<String> directories, List<String> languages) {
    static final String ROOT_FILES = ".";
    static final String OTHER_LANGUAGE = "other";
    private static final int MAX_ENTRIES = 256;
    private static final JsonMapper JSON = JsonMapper.builder().build();

    public LocalImportScope {
        directories = normalized(directories, LocalImportScope::validDirectory);
        languages = normalized(languages, LocalImportScope::validLanguage);
    }

    /** Returns null when nothing is narrowed, so an empty scope equals no scope. */
    public static LocalImportScope of(LocalImportScope requested) {
        if (requested == null) return null;
        LocalImportScope scope = new LocalImportScope(requested.directories(), requested.languages());
        return scope.directories().isEmpty() && scope.languages().isEmpty() ? null : scope;
    }

    static LocalImportScope parse(String canonical) {
        if (canonical == null) return null;
        try {
            JsonNode node = JSON.readTree(canonical);
            LocalImportScope scope =
                    of(new LocalImportScope(strings(node.get("directories")), strings(node.get("languages"))));
            if (scope == null || !scope.canonical().equals(canonical)) throw invalid();
            return scope;
        } catch (JacksonException e) {
            throw invalid();
        }
    }

    /** The scope of a project's most recent approved input, or null for the whole root. */
    static LocalImportScope ofProject(JdbcClient jdbc, long projectId) {
        return parse(jdbc.sql("select scope from job_local_source_inputs where project_id = :project "
                        + "order by approved_at desc, job_id desc limit 1")
                .param("project", projectId)
                .query(String.class)
                .optional()
                .orElse(null));
    }

    String canonical() {
        Map<String, List<String>> value = new LinkedHashMap<>();
        value.put("directories", directories);
        value.put("languages", languages);
        return JSON.writeValueAsString(value);
    }

    boolean includesDirectory(String topLevel) {
        return directories.isEmpty() || directories.contains(topLevel);
    }

    boolean includesLanguage(String language) {
        return languages.isEmpty() || languages.contains(language);
    }

    /** The scope language of a selected path: the inventory language, or {@code other}. */
    static String language(String path) {
        String language = LanguageDetector.detect(path);
        return language == null ? OTHER_LANGUAGE : language;
    }

    private static List<String> normalized(List<String> values, java.util.function.Predicate<String> valid) {
        if (values == null) return List.of();
        if (values.size() > MAX_ENTRIES) throw invalid();
        TreeSet<String> unique = new TreeSet<>();
        for (String value : values) {
            if (value == null || !valid.test(value)) throw invalid();
            unique.add(value);
        }
        return List.copyOf(unique);
    }

    private static boolean validDirectory(String name) {
        return name.equals(ROOT_FILES)
                || (!name.isEmpty()
                        && name.length() <= 255
                        && !name.equals("..")
                        && name.indexOf('/') < 0
                        && name.indexOf('\\') < 0
                        && name.chars().noneMatch(Character::isISOControl));
    }

    private static boolean validLanguage(String language) {
        return language.equals(OTHER_LANGUAGE)
                || LanguageDetector.knownLanguages().contains(language);
    }

    private static List<String> strings(JsonNode node) {
        if (node == null || !node.isArray()) throw invalid();
        List<String> values = new ArrayList<>();
        for (JsonNode item : node) {
            if (!item.isString()) throw invalid();
            values.add(item.asString());
        }
        return values;
    }

    private static LocalImportException invalid() {
        return new LocalImportException("The import scope is not valid. Choose listed folders or languages.", null);
    }
}
