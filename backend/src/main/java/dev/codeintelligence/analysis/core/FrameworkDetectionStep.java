package dev.codeintelligence.analysis.core;

import dev.codeintelligence.job.JobContext;
import dev.codeintelligence.job.JobStep;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

@Component
@Order(FrameworkDetectionStep.ORDER)
public class FrameworkDetectionStep implements JobStep {

    public static final String KEY = "LANGUAGE_FRAMEWORK";
    public static final int ORDER = 300;

    private final DetectionContextFactory detectionContextFactory;

    public FrameworkDetectionStep(DetectionContextFactory detectionContextFactory) {
        this.detectionContextFactory = detectionContextFactory;
    }

    @Override
    public String key() {
        return KEY;
    }

    @Override
    public void run(JobContext ctx) {
        long snapshotId =
                ctx.snapshotId().orElseThrow(() -> new IllegalStateException("no snapshot attached to the job"));
        ctx.updateProgress(20);
        detectionContextFactory.build(snapshotId, ctx.clonePath());
        ctx.updateProgress(100);
    }
}
