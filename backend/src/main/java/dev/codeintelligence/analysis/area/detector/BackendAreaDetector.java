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
public class BackendAreaDetector implements AreaDetector {

    @Override
    public List<AreaSignal> detect(DetectionContext ctx) {
        List<AreaSignal> signals = new ArrayList<>();
        DetectorSupport.mentionSignal(ctx, AreaType.BACKEND, "spring-boot", "**/build.gradle*", "Spring Boot", 0.55)
                .or(() -> DetectorSupport.mentionSignal(
                        ctx, AreaType.BACKEND, "spring-boot", "**/pom.xml", "Spring Boot", 0.55))
                .ifPresent(signals::add);
        DetectorSupport.pathSignal(ctx, AreaType.BACKEND, "**/src/main/java/**", "Java", 0.25)
                .ifPresent(signals::add);
        DetectorSupport.contentSignal(
                        ctx, AreaType.BACKEND, "**/*.java", "Spring Boot", 0.25, "@RestController", "@Service")
                .ifPresent(signals::add);
        if (ctx.mentions("nestjs") || ctx.mentions("@nestjs")) {
            DetectorSupport.mentionSignal(ctx, AreaType.BACKEND, "nestjs", "**/package.json", "NestJS", 0.55)
                    .ifPresent(signals::add);
        } else if (ctx.mentions("express")) {
            DetectorSupport.mentionSignal(ctx, AreaType.BACKEND, "express", "**/package.json", "Express", 0.55)
                    .ifPresent(signals::add);
        } else if (ctx.mentions("django")) {
            DetectorSupport.mentionSignal(ctx, AreaType.BACKEND, "django", "**/requirements.txt", "Django", 0.55)
                    .or(() -> DetectorSupport.mentionSignal(
                            ctx, AreaType.BACKEND, "django", "**/pyproject.toml", "Django", 0.55))
                    .ifPresent(signals::add);
        }
        return signals;
    }
}
