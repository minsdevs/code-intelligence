package dev.codeintelligence.project;

/**
 * Expected analysis depth per inventory language for the local preview, from the adapters this
 * installation actually runs. It is an expectation shown before import, never a result: outcomes
 * are recorded per file after analysis (coverage). Implemented by the analysis side, which owns the
 * adapters; the project package does not depend on analysis.
 */
public interface LocalLanguageCapabilities {

    /** JavaParser (always) or the TS analyzer: parse tree, symbols, static calls, listed framework patterns. */
    String SYMBOLS_AND_CALLS = "SYMBOLS_AND_CALLS";
    /** Declaration patterns from the generic extractor; no call resolution. */
    String STRUCTURE = "STRUCTURE";
    /** Recognised configuration and schema files only (build files, SQL, YAML, Docker, Terraform). */
    String CONFIGURATION = "CONFIGURATION";
    /** Listed and counted; no analyzer for this language in this installation. */
    String INVENTORY_ONLY = "INVENTORY_ONLY";

    String expectedDepth(String language);
}
