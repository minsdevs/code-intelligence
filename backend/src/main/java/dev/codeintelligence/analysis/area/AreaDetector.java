package dev.codeintelligence.analysis.area;

import dev.codeintelligence.analysis.core.DetectionContext;
import java.util.List;

public interface AreaDetector {

    List<AreaSignal> detect(DetectionContext ctx);
}
