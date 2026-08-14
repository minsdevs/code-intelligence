package dev.codeintelligence.analysis.area;

import java.util.List;

public record DetectedArea(AreaType areaType, double confidence, List<String> technologies, List<AreaSignal> signals) {}
