package dev.codeintelligence.project;

import dev.codeintelligence.analysis.ts.TsAnalyzerClient;
import java.util.Set;
import org.springframework.stereotype.Component;

/**
 * Expected analysis depth per inventory language for the local preview, from the adapters this
 * installation actually runs. It is an expectation shown before import, never a result: outcomes
 * are recorded per file after analysis (coverage).
 */
@Component
public class LocalLanguageCapabilities {

    /** JavaParser (always) or the TS analyzer: parse tree, symbols, static calls, listed framework patterns. */
    static final String SYMBOLS_AND_CALLS = "SYMBOLS_AND_CALLS";
    /** Declaration patterns from the generic extractor; no call resolution. */
    static final String STRUCTURE = "STRUCTURE";
    /** Recognised configuration and schema files only (build files, SQL, YAML, Docker, Terraform). */
    static final String CONFIGURATION = "CONFIGURATION";
    /** Listed and counted; no analyzer for this language in this installation. */
    static final String INVENTORY_ONLY = "INVENTORY_ONLY";

    private static final Set<String> CONFIGURATION_LANGUAGES =
            Set.of("gradle", "sql", "yaml", "hcl", "dockerfile", "xml", "json", "properties");

    private final TsAnalyzerClient tsAnalyzer;

    public LocalLanguageCapabilities(TsAnalyzerClient tsAnalyzer) {
        this.tsAnalyzer = tsAnalyzer;
    }

    public String expectedDepth(String language) {
        boolean ts = tsAnalyzer.enabled();
        return switch (language) {
            case "java" -> SYMBOLS_AND_CALLS;
            case "typescript", "javascript" -> ts ? SYMBOLS_AND_CALLS : INVENTORY_ONLY;
            case "python", "go" -> ts ? STRUCTURE : INVENTORY_ONLY;
            default -> CONFIGURATION_LANGUAGES.contains(language) ? CONFIGURATION : INVENTORY_ONLY;
        };
    }
}
