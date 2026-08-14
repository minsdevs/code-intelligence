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
public class TestingAreaDetector implements AreaDetector {

    @Override
    public List<AreaSignal> detect(DetectionContext ctx) {
        List<AreaSignal> signals = new ArrayList<>();
        DetectorSupport.pathSignal(ctx, AreaType.TESTING, "**/src/test/**", "JUnit", 0.30)
                .ifPresent(signals::add);
        DetectorSupport.pathSignal(ctx, AreaType.TESTING, "**/*.test.ts", "Vitest", 0.25)
                .or(() -> DetectorSupport.pathSignal(ctx, AreaType.TESTING, "**/*.test.tsx", "Vitest", 0.25))
                .or(() -> DetectorSupport.pathSignal(ctx, AreaType.TESTING, "**/*.spec.ts", "Jest", 0.25))
                .or(() -> DetectorSupport.pathSignal(ctx, AreaType.TESTING, "**/*.spec.tsx", "Jest", 0.25))
                .ifPresent(signals::add);
        if (ctx.mentions("junit") || ctx.mentions("starter-test")) {
            DetectorSupport.mentionSignal(ctx, AreaType.TESTING, "junit", "**/build.gradle*", "JUnit", 0.25)
                    .or(() -> DetectorSupport.mentionSignal(
                            ctx, AreaType.TESTING, "starter-test", "**/build.gradle*", "JUnit", 0.25))
                    .ifPresent(signals::add);
        } else if (ctx.mentions("vitest")) {
            DetectorSupport.mentionSignal(ctx, AreaType.TESTING, "vitest", "**/package.json", "Vitest", 0.25)
                    .ifPresent(signals::add);
        } else if (ctx.mentions("jest")) {
            DetectorSupport.mentionSignal(ctx, AreaType.TESTING, "jest", "**/package.json", "Jest", 0.25)
                    .ifPresent(signals::add);
        } else if (ctx.mentions("pytest")) {
            DetectorSupport.mentionSignal(ctx, AreaType.TESTING, "pytest", "**/requirements.txt", "pytest", 0.25)
                    .ifPresent(signals::add);
        }
        return signals;
    }
}
