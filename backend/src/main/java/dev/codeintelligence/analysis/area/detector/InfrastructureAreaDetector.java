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
public class InfrastructureAreaDetector implements AreaDetector {

    @Override
    public List<AreaSignal> detect(DetectionContext ctx) {
        List<AreaSignal> signals = new ArrayList<>();
        DetectorSupport.pathSignal(ctx, AreaType.INFRASTRUCTURE, "**/Dockerfile", "Docker", 0.40)
                .or(() -> DetectorSupport.pathSignal(ctx, AreaType.INFRASTRUCTURE, "**/dockerfile", "Docker", 0.40))
                .ifPresent(signals::add);
        DetectorSupport.pathSignal(ctx, AreaType.INFRASTRUCTURE, "**/docker-compose*.yml", "Docker Compose", 0.55)
                .or(() -> DetectorSupport.pathSignal(
                        ctx, AreaType.INFRASTRUCTURE, "**/docker-compose*.yaml", "Docker Compose", 0.55))
                .ifPresent(signals::add);
        DetectorSupport.pathSignal(ctx, AreaType.INFRASTRUCTURE, "**/*.tf", "Terraform", 0.35)
                .ifPresent(signals::add);
        DetectorSupport.pathSignal(ctx, AreaType.INFRASTRUCTURE, "k8s/**/*.yaml", "Kubernetes", 0.40)
                .or(() -> DetectorSupport.pathSignal(ctx, AreaType.INFRASTRUCTURE, "k8s/**/*.yml", "Kubernetes", 0.40))
                .or(() -> DetectorSupport.pathSignal(
                        ctx, AreaType.INFRASTRUCTURE, "kubernetes/**/*.yaml", "Kubernetes", 0.40))
                .ifPresent(signals::add);
        return signals;
    }
}
