package dev.codeintelligence.analysis.core;

import dev.codeintelligence.evidence.EvidenceKind;

public record AnalyzerEvidence(
        String subjectNaturalKey,
        EvidenceKind kind,
        String filePath,
        Integer lineStart,
        Integer lineEnd,
        String excerpt) {}
