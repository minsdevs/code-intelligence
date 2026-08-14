package dev.codeintelligence.analysis.area.detector;

import dev.codeintelligence.analysis.area.AreaDetector;
import dev.codeintelligence.analysis.area.AreaSignal;
import dev.codeintelligence.analysis.area.AreaType;
import dev.codeintelligence.analysis.area.DetectorSupport;
import dev.codeintelligence.analysis.core.DetectionContext;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Component;

@Component
public class AiMlAreaDetector implements AreaDetector {

    @Override
    public List<AreaSignal> detect(DetectionContext ctx) {
        List<AreaSignal> signals = new ArrayList<>();
        if (ctx.mentions("openai")) {
            DetectorSupport.mentionSignal(ctx, AreaType.AI_ML, "openai", "**/package.json", "OpenAI", 0.55)
                    .or(() ->
                            DetectorSupport.mentionSignal(ctx, AreaType.AI_ML, "openai", "**/pom.xml", "OpenAI", 0.55))
                    .or(() -> DetectorSupport.mentionSignal(
                            ctx, AreaType.AI_ML, "openai", "**/build.gradle*", "OpenAI", 0.55))
                    .ifPresent(signals::add);
        } else if (ctx.mentions("anthropic")) {
            DetectorSupport.mentionSignal(ctx, AreaType.AI_ML, "anthropic", "**/package.json", "Anthropic", 0.55)
                    .ifPresent(signals::add);
        } else if (ctx.mentions("langchain")) {
            DetectorSupport.mentionSignal(ctx, AreaType.AI_ML, "langchain", "**/package.json", "LangChain", 0.55)
                    .ifPresent(signals::add);
        } else if (ctx.mentions("tensorflow")) {
            DetectorSupport.mentionSignal(ctx, AreaType.AI_ML, "tensorflow", "**/requirements.txt", "TensorFlow", 0.55)
                    .ifPresent(signals::add);
        }
        DetectorSupport.pathSignal(ctx, AreaType.AI_ML, "**/prompts/**", "Prompts", 0.25)
                .or(() -> DetectorSupport.pathSignal(ctx, AreaType.AI_ML, "**/models/**", "Models", 0.25))
                .ifPresent(signals::add);
        return signals;
    }
}
