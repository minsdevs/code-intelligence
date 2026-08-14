package dev.codeintelligence.analysis.core;

import dev.codeintelligence.common.AnalysisProperties;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

@Component
public class DetectionContextFactory {

    private static final List<String> MANIFEST_GLOBS = List.of(
            "**/package.json",
            "**/pom.xml",
            "**/build.gradle",
            "**/build.gradle.kts",
            "**/settings.gradle",
            "**/settings.gradle.kts",
            "**/Dockerfile",
            "**/dockerfile",
            "**/docker-compose*.yml",
            "**/docker-compose*.yaml",
            "**/*.tf",
            "**/pubspec.yaml",
            "**/.github/workflows/*.yml",
            "**/.github/workflows/*.yaml",
            "**/Jenkinsfile",
            "**/.gitlab-ci.yml",
            "**/vite.config.*",
            "**/webpack.config.*",
            "**/turbo.json",
            "**/nx.json");

    private final JdbcClient jdbc;
    private final AnalysisProperties analysisProperties;

    public DetectionContextFactory(JdbcClient jdbc, AnalysisProperties analysisProperties) {
        this.jdbc = jdbc;
        this.analysisProperties = analysisProperties;
    }

    public DetectionContext build(long snapshotId, Path clonePath) {
        List<InventoriedFile> files = jdbc.sql("""
                        select path, language, size, line_count, content_hash
                        from files where snapshot_id = :snapshotId order by path
                        """)
                .param("snapshotId", snapshotId)
                .query((rs, rowNum) -> new InventoriedFile(
                        rs.getString("path"),
                        rs.getString("language"),
                        rs.getLong("size"),
                        (Integer) rs.getObject("line_count"),
                        rs.getString("content_hash")))
                .list();
        StringBuilder manifest = new StringBuilder();
        for (InventoriedFile file : files) {
            if (!isManifest(file.path())) {
                continue;
            }
            String text = readText(clonePath, file.path());
            if (text != null) {
                manifest.append('\n').append(text.toLowerCase(Locale.ROOT));
            }
        }
        return new DetectionContext(files, manifest.toString(), path -> readText(clonePath, path));
    }

    private boolean isManifest(String path) {
        return MANIFEST_GLOBS.stream().anyMatch(glob -> PathGlobs.matches(path, glob));
    }

    private String readText(Path clonePath, String relative) {
        try {
            Path resolved = SafeRelativePath.resolve(clonePath, relative);
            if (!Files.isRegularFile(resolved)) {
                return null;
            }
            if (Files.size(resolved) > analysisProperties.maxFileSize()) {
                return null;
            }
            byte[] bytes = Files.readAllBytes(resolved);
            if (BinaryFiles.isBinary(relative, bytes)) {
                return null;
            }
            return new String(bytes, StandardCharsets.UTF_8);
        } catch (InvalidFilePathException | IOException e) {
            return null;
        }
    }
}
