package dev.codeintelligence.analysis.core;

import java.util.List;

public record InventoryResult(
        List<InventoriedFile> files,
        int skippedForCount,
        int skippedForSize,
        int skippedBinary,
        int skippedSubmodules) {}
