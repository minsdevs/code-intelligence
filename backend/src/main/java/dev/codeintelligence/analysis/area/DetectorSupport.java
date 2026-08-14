package dev.codeintelligence.analysis.area;

import dev.codeintelligence.analysis.core.DetectionContext;
import dev.codeintelligence.analysis.core.InventoriedFile;
import java.util.Optional;

public final class DetectorSupport {

    private DetectorSupport() {}

    public static Optional<AreaSignal> pathSignal(
            DetectionContext ctx, AreaType type, String glob, String technology, double weight) {
        return ctx.firstMatching(glob).map(file -> new AreaSignal(type, technology, weight, evidenceFor(ctx, file)));
    }

    public static Optional<AreaSignal> mentionSignal(
            DetectionContext ctx, AreaType type, String token, String glob, String technology, double weight) {
        if (!ctx.mentions(token)) {
            return Optional.empty();
        }
        return ctx.firstMatching(glob)
                .or(() -> ctx.files().stream().findFirst())
                .map(file -> new AreaSignal(type, technology, weight, EvidenceRef.dependency(file.path(), token)));
    }

    public static Optional<AreaSignal> contentSignal(
            DetectionContext ctx, AreaType type, String glob, String technology, double weight, String... needles) {
        return ctx.firstContaining(glob, needles).map(file -> {
            String needle = firstFound(ctx.content(file.path()), needles);
            return new AreaSignal(
                    type,
                    technology,
                    weight,
                    EvidenceRef.file(
                            file.path(), ctx.lineOf(file.path(), needle), ctx.excerpt(file.path(), needle, 80)));
        });
    }

    static EvidenceRef evidenceFor(DetectionContext ctx, InventoriedFile file) {
        String excerpt = ctx.excerpt(file.path(), "", 80);
        if (excerpt.isBlank()) {
            excerpt = file.path();
        }
        return EvidenceRef.config(file.path(), excerpt);
    }

    private static String firstFound(String text, String... needles) {
        if (text == null) {
            return needles[0];
        }
        for (String needle : needles) {
            if (text.contains(needle)) {
                return needle;
            }
        }
        return needles[0];
    }
}
