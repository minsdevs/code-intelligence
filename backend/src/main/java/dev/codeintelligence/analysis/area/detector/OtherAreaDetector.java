package dev.codeintelligence.analysis.area.detector;

import dev.codeintelligence.analysis.area.AreaDetector;
import dev.codeintelligence.analysis.area.AreaSignal;
import dev.codeintelligence.analysis.area.AreaType;
import dev.codeintelligence.analysis.area.EvidenceRef;
import dev.codeintelligence.analysis.core.DetectionContext;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.analysis.core.PathGlobs;
import java.util.List;
import org.springframework.stereotype.Component;

@Component
public class OtherAreaDetector implements AreaDetector {

    private static final List<String> CLAIMED = List.of(
            "**/src/main/**",
            "**/src/test/**",
            "**/package.json",
            "**/*.tsx",
            "**/*.ts",
            "**/*.jsx",
            "**/*.js",
            "**/index.html",
            "**/vite.config.*",
            "**/webpack.config.*",
            "android/**",
            "ios/**",
            "**/*.swift",
            "**/pubspec.yaml",
            "**/migration/**",
            "**/*.sql",
            "**/schema.prisma",
            "**/Dockerfile",
            "**/dockerfile",
            "**/docker-compose*.yml",
            "**/docker-compose*.yaml",
            "**/*.tf",
            "k8s/**",
            "kubernetes/**",
            ".github/**",
            "**/.github/**",
            "**/Jenkinsfile",
            "**/.gitlab-ci.yml",
            "**/*.md",
            "docs/**",
            "**/build.gradle",
            "**/build.gradle.kts",
            "**/settings.gradle",
            "**/settings.gradle.kts",
            "**/pom.xml",
            "**/*.java",
            "**/*.kt",
            "**/application*.yml",
            "**/application*.yaml",
            "**/tsconfig.json");

    @Override
    public List<AreaSignal> detect(DetectionContext ctx) {
        List<InventoriedFile> unclaimed = ctx.files().stream()
                .filter(file -> CLAIMED.stream().noneMatch(glob -> PathGlobs.matches(file.path(), glob)))
                .toList();
        if (unclaimed.size() < 3) {
            return List.of();
        }
        InventoriedFile sample = unclaimed.getFirst();
        return List.of(new AreaSignal(AreaType.OTHER, "Other", 0.20, EvidenceRef.config(sample.path(), sample.path())));
    }
}
