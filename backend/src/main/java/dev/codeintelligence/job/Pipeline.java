package dev.codeintelligence.job;

import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import org.springframework.stereotype.Component;

/**
 * Ordered pipeline definition: {@link JobStep} beans are injected in {@code @Order} order and
 * materialized into {@code analysis_job_steps.seq} at enqueue time (§4 step table). IMPORT and
 * REANALYZE share the same full pipeline.
 */
@Component
public class Pipeline {

    private final List<JobStep> steps;

    public Pipeline(List<JobStep> steps) {
        Set<String> keys = new HashSet<>();
        for (JobStep step : steps) {
            if (!keys.add(step.key())) {
                throw new IllegalStateException("Duplicate job step key: " + step.key());
            }
        }
        this.steps = List.copyOf(steps);
    }

    public List<JobStep> stepsFor(JobType type) {
        return steps;
    }

    public Optional<JobStep> find(JobType type, String stepKey) {
        return stepsFor(type).stream()
                .filter(step -> step.key().equals(stepKey))
                .findFirst();
    }
}
