package dev.codeintelligence.common;

import static org.assertj.core.api.Assertions.assertThat;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.lang.syntax.ArchRuleDefinition;
import dev.codeintelligence.analysis.config.BuildFileAnalyzer;
import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.desktop.ManagedProcessWorker;
import dev.codeintelligence.github.GitCloneService;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * G-SEC "no code execution from configuration" (05 §1) and ADR-01 "no loader that imports or
 * evaluates repository config/plugins". Static rules pin every process/script/class-loading
 * entry point of the backend; a dynamic case feeds hostile build files to the build analyzer.
 */
class SecuritySourceExecutionTest {

    private static final JavaClasses PRODUCT = new ClassFileImporter()
            .withImportOption(new ImportOption.DoNotIncludeTests())
            .importPackages("dev.codeintelligence");

    @TempDir
    Path temp;

    @Test
    void onlyTheReviewedProcessHelpersCanStartOperatingSystemProcesses() {
        ArchRuleDefinition.noClasses()
                .that()
                .doNotBelongToAnyOf(ManagedProcessWorker.class, WindowsStorage.class)
                .should()
                .callConstructor(ProcessBuilder.class, String[].class)
                .orShould()
                .callConstructor(ProcessBuilder.class, java.util.List.class)
                .orShould()
                .callMethod(Runtime.class, "exec", String.class)
                .orShould()
                .callMethod(Runtime.class, "exec", String[].class)
                .orShould()
                .callMethod(Runtime.class, "exec", String[].class, String[].class, java.io.File.class)
                .because("analysed repositories must never select or start a process")
                .check(PRODUCT);
    }

    @Test
    void noScriptEngineDynamicClassLoaderOrRemoteCodeLoaderExistsInTheBackend() {
        ArchRuleDefinition.noClasses()
                .should()
                .dependOnClassesThat()
                .resideInAnyPackage(
                        "javax.script..",
                        "groovy..",
                        "org.codehaus.groovy..",
                        "org.gradle..",
                        "org.apache.maven..",
                        "jdk.jshell..",
                        "org.graalvm.polyglot..")
                .because("repository configuration and plugins are parsed as text, never evaluated")
                .check(PRODUCT);
        ArchRuleDefinition.noClasses()
                .should()
                .dependOnClassesThat()
                .areAssignableTo(java.net.URLClassLoader.class)
                .because("no repository-provided class or jar is ever loaded")
                .check(PRODUCT);
    }

    @Test
    void onlyTheFilterNeutralisedCloneServiceMayCheckOutOrResetAWorkingTree() {
        ArchRuleDefinition.noClasses()
                .that()
                .doNotHaveFullyQualifiedName(GitCloneService.class.getName())
                .should()
                .dependOnClassesThat()
                .haveFullyQualifiedName("org.eclipse.jgit.api.CloneCommand")
                .orShould()
                .dependOnClassesThat()
                .haveFullyQualifiedName("org.eclipse.jgit.api.ResetCommand")
                .orShould()
                .dependOnClassesThat()
                .haveFullyQualifiedName("org.eclipse.jgit.api.CheckoutCommand")
                .orShould()
                .dependOnClassesThat()
                .haveFullyQualifiedName("org.eclipse.jgit.api.StatusCommand")
                .orShould()
                .dependOnClassesThat()
                .haveFullyQualifiedName("org.eclipse.jgit.dircache.DirCacheCheckout")
                .orShould()
                .dependOnClassesThat()
                .haveFullyQualifiedName("org.eclipse.jgit.treewalk.FileTreeIterator")
                .because("checkout, reset, status and working-tree iteration apply filter drivers (05 §1)")
                .check(PRODUCT);
    }

    @Test
    void hostileBuildFilesAreReadAsInertTextWithoutEntitiesPluginsOrScripts() throws Exception {
        Path secret = temp.resolve("outside-secret.txt");
        Files.writeString(secret, "OUTSIDE-SNAPSHOT-SENTINEL-7f3c");
        Path sentinel = temp.resolve("executed-sentinel");
        Path repo = temp.resolve("repo");
        Files.createDirectories(repo.resolve("gradle/wrapper"));
        Files.writeString(repo.resolve("pom.xml"), """
                <?xml version="1.0"?>
                <!DOCTYPE project [<!ENTITY leak SYSTEM "%s"><!ENTITY %% remote SYSTEM "http://127.0.0.1:9/x.dtd"> %%remote;]>
                <project><modelVersion>4.0.0</modelVersion><groupId>&leak;</groupId><artifactId>a</artifactId>
                <build><plugins><plugin><groupId>org.codehaus.mojo</groupId><artifactId>exec-maven-plugin</artifactId>
                <executions><execution><phase>validate</phase><goals><goal>exec</goal></goals>
                <configuration><executable>touch</executable><arguments><argument>%s</argument></arguments></configuration>
                </execution></executions></plugin></plugins></build></project>
                """.formatted(secret.toUri(), sentinel));
        Files.writeString(repo.resolve("build.gradle"), """
                plugins { id 'java' }
                new File('%s').createNewFile()
                ['sh', '-c', 'touch %s'].execute()
                apply from: 'https://127.0.0.1:9/remote.gradle'
                dependencies { implementation 'org.example:lib:1.0' }
                """.formatted(sentinel, sentinel));
        Files.writeString(repo.resolve("settings.gradle"), "new File('%s').createNewFile()\n".formatted(sentinel));
        Files.writeString(
                repo.resolve("gradle/wrapper/gradle-wrapper.properties"),
                "distributionUrl=http\\://127.0.0.1\\:9/gradle-bin.zip\n");
        Files.writeString(repo.resolve("package.json"), """
                {"name":"hostile","scripts":{"preinstall":"touch %s","postinstall":"touch %s","prepare":"touch %s"},
                 "dependencies":{"left-pad":"1.3.0"}}
                """.formatted(sentinel, sentinel, sentinel));
        Files.createSymbolicLink(repo.resolve("tsconfig.json"), secret);

        FileInventory inventory = FileInventory.of(java.util.List.of(
                new InventoriedFile("pom.xml", "xml", 0, 0, ""),
                new InventoriedFile("build.gradle", "gradle", 0, 0, ""),
                new InventoriedFile("settings.gradle", "gradle", 0, 0, ""),
                new InventoriedFile("gradle/wrapper/gradle-wrapper.properties", "properties", 0, 0, ""),
                new InventoriedFile("package.json", "json", 0, 0, "")));
        AnalysisResult result = new BuildFileAnalyzer().analyze(new AnalysisContext(1, 1, repo, inventory));

        assertThat(sentinel).doesNotExist();
        assertThat(result.toString()).doesNotContain("OUTSIDE-SNAPSHOT-SENTINEL-7f3c");
        assertThat(result.nodes()).isNotEmpty();
    }
}
