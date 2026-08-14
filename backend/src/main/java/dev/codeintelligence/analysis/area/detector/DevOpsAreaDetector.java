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
public class DevOpsAreaDetector implements AreaDetector {

    @Override
    public List<AreaSignal> detect(DetectionContext ctx) {
        List<AreaSignal> signals = new ArrayList<>();
        DetectorSupport.pathSignal(ctx, AreaType.DEVOPS, ".github/workflows/*.yml", "GitHub Actions", 0.65)
                .or(() -> DetectorSupport.pathSignal(
                        ctx, AreaType.DEVOPS, ".github/workflows/*.yaml", "GitHub Actions", 0.65))
                .or(() -> DetectorSupport.pathSignal(
                        ctx, AreaType.DEVOPS, "**/.github/workflows/*.yml", "GitHub Actions", 0.65))
                .ifPresent(signals::add);
        DetectorSupport.pathSignal(ctx, AreaType.DEVOPS, "**/Jenkinsfile", "Jenkins", 0.55)
                .ifPresent(signals::add);
        DetectorSupport.pathSignal(ctx, AreaType.DEVOPS, "**/.gitlab-ci.yml", "GitLab CI", 0.55)
                .ifPresent(signals::add);
        return signals;
    }
}
