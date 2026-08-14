package dev.codeintelligence.analysis.area;

import dev.codeintelligence.evidence.EvidenceKind;

public record EvidenceRef(String filePath, Integer line, String excerpt, EvidenceKind kind) {

    public static EvidenceRef file(String filePath, Integer line, String excerpt) {
        return new EvidenceRef(filePath, line, excerpt, EvidenceKind.FILE_LINE);
    }

    public static EvidenceRef dependency(String filePath, String excerpt) {
        return new EvidenceRef(filePath, 1, excerpt, EvidenceKind.DEPENDENCY);
    }

    public static EvidenceRef config(String filePath, String excerpt) {
        return new EvidenceRef(filePath, 1, excerpt, EvidenceKind.CONFIG);
    }
}
