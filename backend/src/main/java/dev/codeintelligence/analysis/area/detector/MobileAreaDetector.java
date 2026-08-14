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
public class MobileAreaDetector implements AreaDetector {

    @Override
    public List<AreaSignal> detect(DetectionContext ctx) {
        List<AreaSignal> signals = new ArrayList<>();
        DetectorSupport.pathSignal(ctx, AreaType.MOBILE, "android/**", "Android", 0.55)
                .or(() -> DetectorSupport.pathSignal(ctx, AreaType.MOBILE, "ios/**", "iOS", 0.55))
                .ifPresent(signals::add);
        DetectorSupport.pathSignal(ctx, AreaType.MOBILE, "**/*.swift", "Swift", 0.25)
                .ifPresent(signals::add);
        if (ctx.mentions("react-native") || ctx.mentions("react-native-web")) {
            DetectorSupport.mentionSignal(ctx, AreaType.MOBILE, "react-native", "**/package.json", "React Native", 0.55)
                    .ifPresent(signals::add);
        }
        if (ctx.anyPathMatches("**/pubspec.yaml") || ctx.mentions("flutter")) {
            DetectorSupport.pathSignal(ctx, AreaType.MOBILE, "**/pubspec.yaml", "Flutter", 0.55)
                    .ifPresent(signals::add);
        }
        if (ctx.mentions("com.android.application") || ctx.mentions("com.android.library")) {
            DetectorSupport.mentionSignal(ctx, AreaType.MOBILE, "com.android", "**/build.gradle*", "Android", 0.30)
                    .ifPresent(signals::add);
        }
        return signals;
    }
}
