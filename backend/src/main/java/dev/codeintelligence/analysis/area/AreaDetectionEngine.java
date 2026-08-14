package dev.codeintelligence.analysis.area;

import dev.codeintelligence.analysis.core.DetectionContext;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.springframework.stereotype.Component;

@Component
public class AreaDetectionEngine {

    public static final double AUTO_SELECT_THRESHOLD = 0.5;

    private final List<AreaDetector> detectors;

    public AreaDetectionEngine(List<AreaDetector> detectors) {
        this.detectors = List.copyOf(detectors);
    }

    /** confidence = min(1, sum(weights)); auto-select when >= 0.5. */
    public List<DetectedArea> detect(DetectionContext ctx) {
        Map<AreaType, List<AreaSignal>> byType = new EnumMap<>(AreaType.class);
        for (AreaDetector detector : detectors) {
            for (AreaSignal signal : detector.detect(ctx)) {
                byType.computeIfAbsent(signal.areaType(), key -> new ArrayList<>())
                        .add(signal);
            }
        }
        List<DetectedArea> areas = new ArrayList<>();
        for (Map.Entry<AreaType, List<AreaSignal>> entry : byType.entrySet()) {
            double raw = 0;
            for (AreaSignal signal : entry.getValue()) {
                raw += signal.weight();
            }
            double confidence = Math.min(1.0, Math.round(raw * 10_000.0) / 10_000.0);
            List<String> technologies = entry.getValue().stream()
                    .map(AreaSignal::technology)
                    .filter(Objects::nonNull)
                    .distinct()
                    .toList();
            areas.add(new DetectedArea(entry.getKey(), confidence, technologies, List.copyOf(entry.getValue())));
        }
        return List.copyOf(areas);
    }
}
