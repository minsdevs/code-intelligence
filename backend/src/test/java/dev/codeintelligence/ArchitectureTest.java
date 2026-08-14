package dev.codeintelligence;

import com.tngtech.archunit.base.DescribedPredicate;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.lang.syntax.ArchRuleDefinition;
import com.tngtech.archunit.library.dependencies.SlicesRuleDefinition;
import org.junit.jupiter.api.Test;
import org.springframework.web.bind.annotation.RestController;

/** Baseline architecture rules (§19), enforced from P2 onwards. */
class ArchitectureTest {

    private static final JavaClasses CLASSES = new ClassFileImporter()
            .withImportOption(new ImportOption.DoNotIncludeTests())
            .importPackages("dev.codeintelligence");

    private static final DescribedPredicate<JavaClass> REPOSITORIES = DescribedPredicate.describe(
            "Spring repositories",
            javaClass -> javaClass.isAssignableTo(org.springframework.data.repository.Repository.class)
                    || javaClass.isAnnotatedWith(org.springframework.stereotype.Repository.class));

    @Test
    void controllersMustNotDependOnRepositoriesDirectly() {
        ArchRuleDefinition.noClasses()
                .that()
                .areAnnotatedWith(RestController.class)
                .should()
                .dependOnClassesThat(REPOSITORIES)
                .because("controllers go through services (§19)")
                .check(CLASSES);
    }

    @Test
    void packagesMustBeFreeOfCycles() {
        SlicesRuleDefinition.slices()
                .matching("dev.codeintelligence.(**)")
                .should()
                .beFreeOfCycles()
                .check(CLASSES);
    }

    @Test
    void aiProviderMustStayInsideAiPackage() {
        ArchRuleDefinition.noClasses()
                .that()
                .resideOutsideOfPackage("dev.codeintelligence.ai..")
                .should()
                .dependOnClassesThat()
                .areAssignableTo(dev.codeintelligence.ai.AIProvider.class)
                .because("AIProvider is only used inside the ai package")
                .check(CLASSES);
    }
}
