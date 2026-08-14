package dev.codeintelligence.analysis.config;

import dev.codeintelligence.analysis.area.AreaType;
import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.AnalyzerEvidence;
import dev.codeintelligence.analysis.core.CodeAnalyzer;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.GraphNodeType;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.analysis.core.NaturalKeys;
import dev.codeintelligence.evidence.EvidenceKind;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/** HCL resource-block extraction (§10.3). */
@Component
public class TerraformAnalyzer implements CodeAnalyzer {

    private static final Pattern RESOURCE = Pattern.compile("(?m)^\\s*resource\\s+\"([^\"]+)\"\\s+\"([^\"]+)\"\\s*\\{");

    @Override
    public boolean supports(FileInventory inventory) {
        return inventory.files().stream().anyMatch(file -> isTf(file.path()));
    }

    @Override
    public AnalysisResult analyze(AnalysisContext ctx) {
        GraphCollector collector = new GraphCollector();
        for (InventoriedFile file : ctx.inventory().files()) {
            if (!isTf(file.path())) {
                continue;
            }
            String text = ConfigFileSupport.read(ctx.clonePath(), file.path());
            if (text == null) {
                continue;
            }
            Matcher matcher = RESOURCE.matcher(text);
            while (matcher.find()) {
                String type = matcher.group(1);
                String name = matcher.group(2);
                String key = NaturalKeys.cloud(type, name);
                int line = ConfigFileSupport.lineOf(text, matcher.group(0).strip());
                collector.put(new GraphNodeDraft(
                        GraphNodeType.CLOUD_RESOURCE.name(),
                        key,
                        type + "." + name,
                        file.path(),
                        line,
                        line,
                        AreaType.INFRASTRUCTURE.name(),
                        Map.of("resourceType", type, "resourceName", name)));
                collector.evidence(new AnalyzerEvidence(
                        key,
                        EvidenceKind.FILE_LINE,
                        file.path(),
                        line,
                        line,
                        "resource \"" + type + "\" \"" + name + "\""));
            }
        }
        return collector.toResult();
    }

    static boolean isTf(String path) {
        return path != null && path.toLowerCase(Locale.ROOT).endsWith(".tf");
    }
}
