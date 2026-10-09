package dev.codeintelligence.analysis.java;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.analysis.core.AnalysisCacheWeight;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class JavaCacheAccountingTest {
    @Test
    void sharedObjectsAreCountedOnceButDistinctEqualObjectsAreStillCharged() {
        String first = new String("same graph metadata");
        String second = new String("same graph metadata");
        long shared = AnalysisCacheWeight.of(List.of(first, first));
        long distinct = AnalysisCacheWeight.of(List.of(first, second));
        assertThat(shared).isLessThan(distinct);
        Map<String, Object> metadata = Map.of("name", first);
        assertThat(AnalysisCacheWeight.of(List.of(metadata, metadata)))
                .isLessThan(AnalysisCacheWeight.of(List.of(metadata, Map.of("name", second))));
    }
}
