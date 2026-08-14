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
public class FrontendAreaDetector implements AreaDetector {

    @Override
    public List<AreaSignal> detect(DetectionContext ctx) {
        List<AreaSignal> signals = new ArrayList<>();
        if (ctx.mentions("\"react\"") || ctx.mentions("react-dom") || ctx.mentions("react-router")) {
            DetectorSupport.mentionSignal(ctx, AreaType.FRONTEND, "react", "**/package.json", "React", 0.55)
                    .ifPresent(signals::add);
        } else if (ctx.mentions("\"vue\"") || ctx.mentions("vue-router")) {
            DetectorSupport.mentionSignal(ctx, AreaType.FRONTEND, "vue", "**/package.json", "Vue", 0.55)
                    .ifPresent(signals::add);
        } else if (ctx.mentions("@angular/core") || ctx.mentions("\"angular\"")) {
            DetectorSupport.mentionSignal(ctx, AreaType.FRONTEND, "angular", "**/package.json", "Angular", 0.55)
                    .ifPresent(signals::add);
        }
        DetectorSupport.pathSignal(ctx, AreaType.FRONTEND, "**/*.tsx", "TypeScript", 0.20)
                .ifPresent(signals::add);
        DetectorSupport.pathSignal(ctx, AreaType.FRONTEND, "**/index.html", "HTML", 0.15)
                .ifPresent(signals::add);
        if (ctx.anyPathMatches("**/vite.config.*") || ctx.mentions("vite")) {
            DetectorSupport.pathSignal(ctx, AreaType.FRONTEND, "**/vite.config.*", "Vite", 0.20)
                    .or(() -> DetectorSupport.mentionSignal(
                            ctx, AreaType.FRONTEND, "vite", "**/package.json", "Vite", 0.20))
                    .ifPresent(signals::add);
        } else if (ctx.anyPathMatches("**/webpack.config.*") || ctx.mentions("webpack")) {
            DetectorSupport.pathSignal(ctx, AreaType.FRONTEND, "**/webpack.config.*", "webpack", 0.20)
                    .or(() -> DetectorSupport.mentionSignal(
                            ctx, AreaType.FRONTEND, "webpack", "**/package.json", "webpack", 0.20))
                    .ifPresent(signals::add);
        }
        return signals;
    }
}
