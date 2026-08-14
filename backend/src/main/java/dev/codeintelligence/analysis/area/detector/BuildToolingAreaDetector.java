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
public class BuildToolingAreaDetector implements AreaDetector {

    @Override
    public List<AreaSignal> detect(DetectionContext ctx) {
        List<AreaSignal> signals = new ArrayList<>();
        DetectorSupport.pathSignal(ctx, AreaType.BUILD_TOOLING, "**/build.gradle", "Gradle", 0.20)
                .or(() ->
                        DetectorSupport.pathSignal(ctx, AreaType.BUILD_TOOLING, "**/build.gradle.kts", "Gradle", 0.20))
                .or(() -> DetectorSupport.pathSignal(ctx, AreaType.BUILD_TOOLING, "**/pom.xml", "Maven", 0.20))
                .or(() -> DetectorSupport.pathSignal(ctx, AreaType.BUILD_TOOLING, "**/Makefile", "Make", 0.20))
                .ifPresent(signals::add);
        if (ctx.anyPathMatches("**/.eslintrc*")
                || ctx.anyPathMatches("**/eslint.config.*")
                || ctx.anyPathMatches("**/.prettierrc*")
                || ctx.mentions("spotless")
                || ctx.mentions("checkstyle")) {
            DetectorSupport.pathSignal(ctx, AreaType.BUILD_TOOLING, "**/.eslintrc*", "ESLint", 0.20)
                    .or(() -> DetectorSupport.pathSignal(
                            ctx, AreaType.BUILD_TOOLING, "**/eslint.config.*", "ESLint", 0.20))
                    .or(() -> DetectorSupport.pathSignal(
                            ctx, AreaType.BUILD_TOOLING, "**/.prettierrc*", "Prettier", 0.20))
                    .or(() -> DetectorSupport.mentionSignal(
                            ctx, AreaType.BUILD_TOOLING, "spotless", "**/build.gradle*", "Spotless", 0.20))
                    .ifPresent(signals::add);
        }
        if (ctx.anyPathMatches("**/turbo.json") || ctx.mentions("turbo")) {
            DetectorSupport.pathSignal(ctx, AreaType.BUILD_TOOLING, "**/turbo.json", "Turbo", 0.40)
                    .ifPresent(signals::add);
        } else if (ctx.anyPathMatches("**/nx.json") || ctx.mentions("\"nx\"")) {
            DetectorSupport.pathSignal(ctx, AreaType.BUILD_TOOLING, "**/nx.json", "Nx", 0.40)
                    .ifPresent(signals::add);
        }
        return signals;
    }
}
