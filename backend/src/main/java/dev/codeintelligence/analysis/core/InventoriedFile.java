package dev.codeintelligence.analysis.core;

public record InventoriedFile(String path, String language, long size, Integer lineCount, String contentHash) {}
