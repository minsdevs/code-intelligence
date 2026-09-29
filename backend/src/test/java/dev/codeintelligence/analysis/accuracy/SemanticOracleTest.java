package dev.codeintelligence.analysis.accuracy;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.codeintelligence.analysis.accuracy.SemanticOracle.Fact;
import dev.codeintelligence.analysis.accuracy.SemanticOracle.Ignored;
import java.util.List;
import org.junit.jupiter.api.Test;

class SemanticOracleTest {
    @Test
    void reportsMissingUnexpectedChangedAndDuplicateFactsWithoutDependingOnOrder() {
        var expected = List.of(new Fact("node route:/", "App.tsx"), new Fact("edge CALLS a -> b", "CONFIRMED"));
        var actual = List.of(
                new Fact("edge CALLS a -> b", "POSSIBLE"),
                new Fact("finding ORPHAN_ROUTE", "LOW"),
                new Fact("finding ORPHAN_ROUTE", "LOW"));
        assertThat(SemanticOracle.differences(expected, actual, List.of()))
                .containsExactly(
                        "! duplicate actual finding ORPHAN_ROUTE",
                        "+ unexpected finding ORPHAN_ROUTE = LOW",
                        "- missing node route:/ = App.tsx",
                        "~ changed edge CALLS a -> b expected=CONFIRMED actual=POSSIBLE");
        assertThat(SemanticOracle.differences(expected, expected.reversed(), List.of()))
                .isEmpty();
    }

    @Test
    void ignoresOnlyReviewedExactFactsAndRequiresReasons() {
        var fact = new Fact("finding UNMATCHED_API_CALL", "MEDIUM");
        var ignored = List.of(new Ignored(fact, "[검증 필요] backend is outside this fixture"));
        assertThat(SemanticOracle.differences(List.of(), List.of(fact), ignored))
                .isEmpty();
        assertThat(SemanticOracle.differences(List.of(), List.of(new Fact(fact.key(), "HIGH")), ignored))
                .containsExactly("+ unexpected finding UNMATCHED_API_CALL = HIGH");
        assertThatThrownBy(() -> new Ignored(fact, " ")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> SemanticOracle.differences(List.of(fact), List.of(fact), ignored))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
