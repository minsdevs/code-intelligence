package dev.codeintelligence.evidence;

public record NewEvidence(EvidenceKind kind, String filePath, Integer lineStart, Integer lineEnd, String excerpt) {}
