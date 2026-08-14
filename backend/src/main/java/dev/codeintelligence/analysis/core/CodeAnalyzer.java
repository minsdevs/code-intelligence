package dev.codeintelligence.analysis.core;

/**
 * Language/config analyzer SPI (§10.1). Implementations are registered as Spring beans and injected
 * as a list; adding a language means adding an implementation, not editing the pipeline.
 */
public interface CodeAnalyzer {

    boolean supports(FileInventory inventory);

    AnalysisResult analyze(AnalysisContext ctx);
}
