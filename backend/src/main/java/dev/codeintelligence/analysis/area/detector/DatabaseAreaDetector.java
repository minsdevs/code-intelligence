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
public class DatabaseAreaDetector implements AreaDetector {

    @Override
    public List<AreaSignal> detect(DetectionContext ctx) {
        List<AreaSignal> signals = new ArrayList<>();
        DetectorSupport.pathSignal(ctx, AreaType.DATABASE, "**/migration/**", "Flyway", 0.25)
                .ifPresent(signals::add);
        if (ctx.mentions("flyway")) {
            DetectorSupport.mentionSignal(ctx, AreaType.DATABASE, "flyway", "**/build.gradle*", "Flyway", 0.20)
                    .or(() -> DetectorSupport.mentionSignal(
                            ctx, AreaType.DATABASE, "flyway", "**/pom.xml", "Flyway", 0.20))
                    .ifPresent(signals::add);
        } else if (ctx.mentions("liquibase")) {
            DetectorSupport.mentionSignal(ctx, AreaType.DATABASE, "liquibase", "**/build.gradle*", "Liquibase", 0.20)
                    .ifPresent(signals::add);
        }
        DetectorSupport.pathSignal(ctx, AreaType.DATABASE, "**/*.sql", "SQL", 0.15)
                .ifPresent(signals::add);
        DetectorSupport.contentSignal(ctx, AreaType.DATABASE, "**/*.java", "JPA", 0.20, "@Entity")
                .ifPresent(signals::add);
        DetectorSupport.pathSignal(ctx, AreaType.DATABASE, "**/schema.prisma", "Prisma", 0.55)
                .ifPresent(signals::add);
        if (ctx.mentions("postgresql") || ctx.mentions("postgres")) {
            DetectorSupport.mentionSignal(ctx, AreaType.DATABASE, "postgres", "**/build.gradle*", "PostgreSQL", 0.10)
                    .or(() -> DetectorSupport.pathSignal(
                            ctx, AreaType.DATABASE, "**/application*.yml", "PostgreSQL", 0.10))
                    .ifPresent(signals::add);
        }
        return signals;
    }
}
