package dev.codeintelligence.analysis.core;

import java.nio.file.Path;

public record AnalysisContext(long projectId, long snapshotId, Path clonePath, FileInventory inventory) {}
