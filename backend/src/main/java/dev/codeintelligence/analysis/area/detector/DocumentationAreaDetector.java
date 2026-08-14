package dev.codeintelligence.analysis.area.detector;

import dev.codeintelligence.analysis.area.AreaDetector;
import dev.codeintelligence.analysis.area.AreaSignal;
import dev.codeintelligence.analysis.area.AreaType;
import dev.codeintelligence.analysis.area.DetectorSupport;
import dev.codeintelligence.analysis.core.DetectionContext;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Component;

@Component
public class DocumentationAreaDetector implements AreaDetector {

    @Override
    public List<AreaSignal> detect(DetectionContext ctx) {
        List<AreaSignal> signals = new ArrayList<>();
        DetectorSupport.pathSignal(ctx, AreaType.DOCUMENTATION, "docs/**", "Docs", 0.40)
                .ifPresent(signals::add);
        long mdCount = ctx.countMatching("**/*.md");
        double mdRatio =
                ctx.files().isEmpty() ? 0 : (double) mdCount / ctx.files().size();
        if (mdCount >= 3 || mdRatio >= 0.3) {
            DetectorSupport.pathSignal(ctx, AreaType.DOCUMENTATION, "**/*.md", "Markdown", 0.25)
                    .ifPresent(signals::add);
        } else if (mdCount > 0) {
            DetectorSupport.pathSignal(ctx, AreaType.DOCUMENTATION, "**/*.md", "Markdown", 0.10)
                    .ifPresent(signals::add);
        }
        if (ctx.mentions("docusaurus")) {
            DetectorSupport.mentionSignal(
                            ctx, AreaType.DOCUMENTATION, "docusaurus", "**/package.json", "Docusaurus", 0.55)
                    .ifPresent(signals::add);
        } else if (ctx.mentions("mkdocs")) {
            DetectorSupport.pathSignal(ctx, AreaType.DOCUMENTATION, "**/mkdocs.yml", "MkDocs", 0.55)
                    .ifPresent(signals::add);
        }
        return signals;
    }
}
