package dev.codeintelligence.analysis.ts;

import dev.codeintelligence.project.LocalLanguageCapabilities;
import java.util.Set;
import org.springframework.stereotype.Component;

/** The preview's expected depth per language: JavaParser always, the TS analyzer when enabled. */
@Component
public class TsLanguageCapabilities implements LocalLanguageCapabilities {

    private static final Set<String> CONFIGURATION_LANGUAGES =
            Set.of("gradle", "sql", "yaml", "hcl", "dockerfile", "xml", "json", "properties");

    private final TsAnalyzerClient tsAnalyzer;

    public TsLanguageCapabilities(TsAnalyzerClient tsAnalyzer) {
        this.tsAnalyzer = tsAnalyzer;
    }

    @Override
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
