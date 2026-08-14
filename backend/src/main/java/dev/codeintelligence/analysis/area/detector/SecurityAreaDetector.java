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
public class SecurityAreaDetector implements AreaDetector {

    @Override
    public List<AreaSignal> detect(DetectionContext ctx) {
        List<AreaSignal> signals = new ArrayList<>();
        if (ctx.mentions("spring-security") || ctx.mentions("spring-boot-starter-security")) {
            DetectorSupport.mentionSignal(
                            ctx, AreaType.SECURITY, "spring-security", "**/build.gradle*", "Spring Security", 0.55)
                    .or(() -> DetectorSupport.mentionSignal(
                            ctx, AreaType.SECURITY, "starter-security", "**/build.gradle*", "Spring Security", 0.55))
                    .ifPresent(signals::add);
        } else if (ctx.mentions("passport")) {
            DetectorSupport.mentionSignal(ctx, AreaType.SECURITY, "passport", "**/package.json", "Passport", 0.55)
                    .ifPresent(signals::add);
        } else if (ctx.mentions("jsonwebtoken") || ctx.mentions("jjwt") || ctx.mentions("\"jwt\"")) {
            DetectorSupport.mentionSignal(ctx, AreaType.SECURITY, "jwt", "**/package.json", "JWT", 0.55)
                    .ifPresent(signals::add);
        }
        if (ctx.anyPath(path -> path.replace('\\', '/').contains("/auth/"))) {
            DetectorSupport.pathSignal(ctx, AreaType.SECURITY, "**/auth/**", "Auth", 0.25)
                    .ifPresent(signals::add);
        }
        return signals;
    }
}
