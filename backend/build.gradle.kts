import java.security.MessageDigest
import java.util.jar.JarFile
import java.util.zip.ZipFile
import org.springframework.boot.gradle.tasks.bundling.BootJar

plugins {
    java
    id("org.springframework.boot") version "4.1.0"
    id("io.spring.dependency-management") version "1.1.7"
    id("com.diffplug.spotless") version "8.9.0"
}

group = "dev.codeintelligence"
version = "0.0.1-SNAPSHOT"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

repositories {
    mavenCentral()
}

// Security patch alignment, reviewed against the packaged dependency inventory.
// Keep each family on its existing minor line; do not mix patched core modules
// with older transitive members. See docs/audit/pre-release-candidate-2026-10-05.md.
dependencyManagement {
    imports {
        mavenBom("org.springframework:spring-framework-bom:7.0.9")
        mavenBom("com.fasterxml.jackson:jackson-bom:2.21.7")
        mavenBom("tools.jackson:jackson-bom:3.1.7")
        mavenBom("io.netty:netty-bom:4.2.17.Final")
        mavenBom("org.apache.logging.log4j:log4j-bom:2.25.5")
    }
    dependencies {
        dependency("org.postgresql:postgresql:42.7.12")
        dependencySet("org.apache.tomcat.embed:11.0.26") {
            entry("tomcat-embed-core")
            entry("tomcat-embed-el")
            entry("tomcat-embed-websocket")
        }
    }
}

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    implementation("org.springframework.boot:spring-boot-starter-data-redis")
    implementation("org.springframework.boot:spring-boot-starter-flyway")
    implementation("org.springframework.boot:spring-boot-starter-restclient")
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.boot:spring-boot-starter-security-oauth2-client")
    implementation("org.springframework.boot:spring-boot-starter-session-data-redis")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.springframework.boot:spring-boot-starter-webmvc")
    implementation("org.eclipse.jgit:org.eclipse.jgit:7.3.0.202506031305-r")
    implementation("com.github.javaparser:javaparser-symbol-solver-core:3.28.2")
    // jsqlparser 5.3 declares its JMH benchmark harness (and with it jopt-simple and commons-math3)
    // in compile scope; no parser class references it, so it stays out of the product runtime.
    implementation("com.github.jsqlparser:jsqlparser:5.3") {
        exclude(group = "org.openjdk.jmh")
    }
    implementation("org.flywaydb:flyway-database-postgresql")
    implementation("org.springdoc:springdoc-openapi-starter-webmvc-ui:3.1.0")
    runtimeOnly("org.postgresql:postgresql")

    testImplementation("org.springframework.boot:spring-boot-starter-actuator-test")
    testImplementation("org.springframework.boot:spring-boot-starter-data-jpa-test")
    testImplementation("org.springframework.boot:spring-boot-starter-data-redis-test")
    testImplementation("org.springframework.boot:spring-boot-starter-flyway-test")
    testImplementation("org.springframework.boot:spring-boot-starter-restclient-test")
    testImplementation("org.springframework.boot:spring-boot-starter-security-oauth2-client-test")
    testImplementation("org.springframework.boot:spring-boot-starter-security-test")
    testImplementation("org.springframework.boot:spring-boot-starter-validation-test")
    testImplementation("org.springframework.boot:spring-boot-starter-webmvc-test")
    testImplementation("org.springframework.boot:spring-boot-testcontainers")
    testImplementation("org.testcontainers:testcontainers-junit-jupiter")
    testImplementation("org.testcontainers:testcontainers-postgresql")
    testImplementation("org.awaitility:awaitility")
    testImplementation("com.tngtech.archunit:archunit-junit5:1.4.1")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

spotless {
    java {
        target("src/**/*.java")
        palantirJavaFormat("2.97.0")
    }
}

tasks.withType<Test> {
    useJUnitPlatform()
}

val desktopControlDependencies = providers.provider {
    val artifacts = configurations.runtimeClasspath.get().resolvedConfiguration.resolvedArtifacts
        .filter { artifact ->
            val id = artifact.moduleVersion.id
            (id.group == "tools.jackson.core" && id.name in setOf("jackson-core", "jackson-databind")) ||
                (id.group == "com.fasterxml.jackson.core" && id.name == "jackson-annotations")
        }
        .sortedWith(compareBy({ it.moduleVersion.id.group }, { it.name }, { it.moduleVersion.id.version }))
    val coordinates = artifacts.map { "${it.moduleVersion.id.group}:${it.name}" }
    require(artifacts.size == 3 && coordinates == listOf(
        "com.fasterxml.jackson.core:jackson-annotations",
        "tools.jackson.core:jackson-core",
        "tools.jackson.core:jackson-databind",
    )) { "Unexpected desktop control dependency set: $coordinates" }
    artifacts
}

val desktopControlMultiRelease = desktopControlDependencies.map { artifacts ->
    artifacts.any { artifact ->
        JarFile(artifact.file).use { jar ->
            jar.manifest?.mainAttributes?.getValue("Multi-Release")?.equals("true", ignoreCase = true) == true
        }
    }
}

fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (count > 0) digest.update(buffer, 0, count)
        }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}

fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(bytes)
    .joinToString("") { "%02x".format(it) }

fun desktopControlClass(relative: String): Boolean = relative.matches(
    Regex("dev/codeintelligence/desktop/(DesktopControlApplication|NativeLeaseWorker(?:[$].*)?|ManagedProcessWorker(?:[$].*)?)\\.class")
)

fun controlLicenseEntry(entry: String): Boolean = entry.startsWith("META-INF/") &&
    (entry.substringAfterLast('/').contains("LICENSE", ignoreCase = true) ||
        entry.substringAfterLast('/').contains("NOTICE", ignoreCase = true))

fun controlLicensePath(group: String, artifact: String, version: String, entry: String): String =
    "META-INF/licenses/$group/$artifact/$version/${entry.substringAfter("META-INF/")}"

val desktopControlProvenance = layout.buildDirectory.file("libs/code-intelligence-control-provenance.json")

val desktopControlJar by tasks.registering(Jar::class) {
    group = "build"
    description = "Builds the minimal desktop lease/process-control runtime without Spring Boot."
    dependsOn(tasks.named("classes"))
    archiveFileName.set("code-intelligence-control.jar")
    destinationDirectory.set(layout.buildDirectory.dir("libs"))
    isReproducibleFileOrder = true
    isPreserveFileTimestamps = false
    duplicatesStrategy = DuplicatesStrategy.FAIL
    manifest.attributes["Main-Class"] = "dev.codeintelligence.desktop.DesktopControlApplication"
    if (desktopControlMultiRelease.get()) manifest.attributes["Multi-Release"] = "true"
    outputs.file(desktopControlProvenance)

    val classesDir = layout.buildDirectory.dir("classes/java/main")
    from(classesDir) {
        include { element -> element.isDirectory || desktopControlClass(element.path) }
    }
    from(desktopControlDependencies.map { artifacts ->
        artifacts.map { artifact ->
            zipTree(artifact.file).matching {
                exclude(
                    "META-INF/MANIFEST.MF", "module-info.class", "META-INF/versions/*/module-info.class",
                    "META-INF/*.SF", "META-INF/*.RSA", "META-INF/*.DSA", "META-INF/*LICENSE*", "META-INF/*NOTICE*"
                )
            }
        }
    })
    desktopControlDependencies.get().forEach { artifact ->
        val id = artifact.moduleVersion.id
        from(zipTree(artifact.file).matching {
            include { element -> element.isDirectory || controlLicenseEntry(element.path) }
        }) {
            eachFile {
                path = controlLicensePath(id.group, artifact.name, id.version, path)
            }
        }
    }

    doLast {
        val jar = archiveFile.get().asFile
        val provenance = desktopControlProvenance.get().asFile
        val classRoot = classesDir.get().asFile
        val classFiles = classRoot.walkTopDown().filter { file ->
            file.isFile && desktopControlClass(file.relativeTo(classRoot).invariantSeparatorsPath)
        }.sortedBy { it.relativeTo(classRoot).invariantSeparatorsPath }.toList()
        val deps = desktopControlDependencies.get()
        require(deps.size == 3) { "CONTROL_DEPS_COUNT" }
        val licenseEntries = mutableListOf<String>()
        deps.forEach { artifact ->
            ZipFile(artifact.file).use { zip ->
                zip.entries().asSequence().filter { entry ->
                    !entry.isDirectory && controlLicenseEntry(entry.name)
                }.forEach { entry ->
                    licenseEntries += controlLicensePath(
                        artifact.moduleVersion.id.group, artifact.name, artifact.moduleVersion.id.version, entry.name
                    )
                }
            }
        }
        val json = groovy.json.JsonOutput.prettyPrint(groovy.json.JsonOutput.toJson(mapOf(
            "format" to 1,
            "kind" to "DESKTOP_CONTROL_RUNTIME",
            "mainClass" to "dev.codeintelligence.desktop.DesktopControlApplication",
            "jarSha256" to sha256(jar),
            "classes" to classFiles.associate { it.relativeTo(classRoot).invariantSeparatorsPath to sha256(it) },
            "dependencies" to deps.map { artifact -> mapOf(
                "groupId" to artifact.moduleVersion.id.group,
                "artifactId" to artifact.name,
                "version" to artifact.moduleVersion.id.version,
                "fileName" to artifact.file.name,
                "sha256" to sha256(artifact.file),
            ) },
            "licenses" to licenseEntries.sorted(),
        )))
        provenance.writeText(json + "\n", Charsets.UTF_8)

        JarFile(jar).use { built ->
            val manifest = built.manifest
            require(manifest.mainAttributes.getValue("Main-Class") == "dev.codeintelligence.desktop.DesktopControlApplication") { "CONTROL_MAIN_CLASS" }
            require(manifest.mainAttributes.getValue("Class-Path") == null) { "CONTROL_CLASS_PATH" }
            require((manifest.mainAttributes.getValue("Multi-Release")?.equals("true", ignoreCase = true) == true) == desktopControlMultiRelease.get()) { "CONTROL_MULTI_RELEASE" }
            val entries = built.entries().asSequence().filterNot { it.isDirectory }.toList()
            require(entries.none { it.name.startsWith("org/springframework/") }) { "CONTROL_SPRING_CLASS" }
            val builtClasses = entries.map { it.name }.filter(::desktopControlClass).sorted()
            val expectedClasses = classFiles.map { it.relativeTo(classRoot).invariantSeparatorsPath }.sorted()
            require(builtClasses == expectedClasses) { "CONTROL_CLASS_SET" }
            for (file in classFiles) {
                val relative = file.relativeTo(classRoot).invariantSeparatorsPath
                val entry = built.getEntry(relative) ?: error("Missing control class $relative")
                require(built.getInputStream(entry).use { sha256(it.readBytes()) } == sha256(file)) { "CONTROL_CLASS_BYTES" }
            }
            val expectedLicenses = mutableMapOf<String, Pair<File, String>>()
            for (artifact in deps) {
                ZipFile(artifact.file).use { source ->
                    source.entries().asSequence().filter { entry ->
                        !entry.isDirectory && controlLicenseEntry(entry.name)
                    }.forEach { entry ->
                        expectedLicenses[controlLicensePath(
                            artifact.moduleVersion.id.group, artifact.name, artifact.moduleVersion.id.version, entry.name
                        )] = artifact.file to entry.name
                    }
                }
            }
            require(licenseEntries.sorted() == expectedLicenses.keys.sorted()) { "CONTROL_LICENSE_SET" }
            for ((target, source) in expectedLicenses) {
                val builtEntry = built.getEntry(target) ?: error("Missing control license $target")
                val builtBytes = built.getInputStream(builtEntry).use { it.readBytes() }
                val originalBytes = ZipFile(source.first).use { zip ->
                    zip.getInputStream(zip.getEntry(source.second)).use { it.readBytes() }
                }
                require(builtBytes.contentEquals(originalBytes)) { "CONTROL_LICENSE_BYTES" }
            }
        }

        val parsed = groovy.json.JsonSlurper().parseText(provenance.readText(Charsets.UTF_8)) as Map<*, *>
        require(parsed["format"] == 1) { "CONTROL_PROVENANCE_FORMAT" }
        require(parsed["kind"] == "DESKTOP_CONTROL_RUNTIME") { "CONTROL_PROVENANCE_KIND" }
        require(parsed["mainClass"] == "dev.codeintelligence.desktop.DesktopControlApplication") { "CONTROL_PROVENANCE_MAIN" }
        require(parsed["jarSha256"] == sha256(jar)) { "CONTROL_PROVENANCE_JAR" }
        val parsedClasses = parsed["classes"] as Map<*, *>
        require(parsedClasses == classFiles.associate { it.relativeTo(classRoot).invariantSeparatorsPath to sha256(it) }) { "CONTROL_PROVENANCE_CLASSES" }
        val parsedDependencies = parsed["dependencies"] as List<*>
        require(parsedDependencies.size == 3) { "CONTROL_PROVENANCE_DEPS_COUNT" }
        require(parsedDependencies == deps.map { artifact -> mapOf(
            "groupId" to artifact.moduleVersion.id.group,
            "artifactId" to artifact.name,
            "version" to artifact.moduleVersion.id.version,
            "fileName" to artifact.file.name,
            "sha256" to sha256(artifact.file),
        ) }) { "CONTROL_PROVENANCE_DEPS" }
        require(parsed["licenses"] == licenseEntries.sorted()) { "CONTROL_PROVENANCE_LICENSES" }
    }
}

tasks.named<BootJar>("bootJar") {
    mainClass.set("dev.codeintelligence.CodeIntelligenceBackendApplication")
    dependsOn(desktopControlJar)
}
// Explicit opt-in gate: requires installed frontend dependencies and local Playwright Chromium.
tasks.test {
    exclude("**/SnapshotSourceContractIntegrationTest.class")
    // Needs the real sidecar supplied by accuracyTest, never an in-process analyzer fake.
    exclude("**/ReactRouteBindingIntegrationTest.class")
    exclude("**/WorkloadMemoryHarnessTest.class")
}
val buildSnapshotSourceFrontend by tasks.registering(Exec::class) {
    description = "Builds the real UI before snapshot source integration tests."
    workingDir(layout.projectDirectory.dir("../frontend"))
    commandLine("npm", "run", "build")
}
tasks.register<Test>("snapshotSourceTest") {
    description = "S1: Java/TS x six source-contract scenarios, including real backend browser paths."
    group = "verification"
    dependsOn(buildSnapshotSourceFrontend)
    testClassesDirs = sourceSets.test.get().output.classesDirs
    classpath = sourceSets.test.get().runtimeClasspath
    filter { includeTestsMatching("*SnapshotSourceContractIntegrationTest") }
    outputs.upToDateWhen { false }
    testLogging { events("passed", "failed"); showStandardStreams = true }
}
tasks.processResources {
    mustRunAfter(buildSnapshotSourceFrontend)
    from(layout.projectDirectory.dir("../frontend/dist")) {
        into("static")
    }
}

tasks.register<Test>("accuracyTest") {
    description = "Checks reviewed fixture semantics; run via ../accuracy-gate for the real local TS analyzer."
    group = "verification"
    testClassesDirs = sourceSets.test.get().output.classesDirs
    classpath = sourceSets.test.get().runtimeClasspath
    filter { includeTestsMatching("dev.codeintelligence.analysis.accuracy.*Test") }
    val tsUrl = providers.gradleProperty("accuracyTsUrl")
    doFirst {
        require(tsUrl.isPresent) { "Use ./accuracy-gate at the repository root (real TS analyzer required)." }
        require(tsUrl.get().matches(Regex("http://127\\.0\\.0\\.1:[0-9]+"))) { "Only a local analyzer is allowed." }
        systemProperty("accuracy.ts-url", tsUrl.get())
    }
    outputs.upToDateWhen { false }
    testLogging {
        events("passed", "failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        showStandardStreams = true
    }
}

tasks.register<Test>("workloadMemoryTest") {
    description = "G-PERF backend heap harness; run via ../validation/pre-release/workload-backend-memory.cjs."
    group = "verification"
    testClassesDirs = sourceSets.test.get().output.classesDirs
    classpath = sourceSets.test.get().runtimeClasspath
    filter { includeTestsMatching("dev.codeintelligence.analysis.WorkloadMemoryHarnessTest") }
    val fixture = providers.gradleProperty("workloadFixture")
    val tsUrl = providers.gradleProperty("workloadTsUrl")
    val heap = providers.gradleProperty("workloadHeap").orElse("2048m")
    val dumpDir = providers.gradleProperty("workloadHeapDumpDir")
    val explainMs = providers.gradleProperty("workloadExplainMs")
    val explainLog = providers.gradleProperty("workloadExplainLog")
    val jfr = providers.gradleProperty("workloadJfr")
    val extraJvmArgs = providers.gradleProperty("workloadJvmArgs")
    doFirst {
        require(fixture.isPresent && tsUrl.isPresent) { "Use validation/pre-release/workload-backend-memory.cjs." }
        require(tsUrl.get().matches(Regex("http://127\\.0\\.0\\.1:[0-9]+"))) { "Only a local analyzer is allowed." }
        systemProperty("workload.fixture", fixture.get())
        systemProperty("workload.ts-url", tsUrl.get())
        if (explainMs.isPresent && explainLog.isPresent) {
            systemProperty("workload.explain-ms", explainMs.get())
            systemProperty("workload.explain-log", explainLog.get())
        }
    }
    // The desktop backend's heap options (desktop/src/jvm-options.cjs) with an optional heap dump.
    minHeapSize = "64m"
    maxHeapSize = heap.get()
    jvmArgs("-XX:+UseSerialGC")
    if (dumpDir.isPresent) jvmArgs("-XX:+HeapDumpOnOutOfMemoryError", "-XX:HeapDumpPath=${dumpDir.get()}")
    if (jfr.isPresent) jvmArgs("-XX:StartFlightRecording=filename=${jfr.get()},settings=profile")
    // Observation only: compare collector settings against the desktop's (space-separated -XX/-X options).
    if (extraJvmArgs.isPresent) {
        val extra = extraJvmArgs.get().split(" ").filter { it.isNotBlank() }
        require(extra.all { it.matches(Regex("-X[A-Za-z0-9:+=._-]+")) }) { "Only -X JVM options are allowed." }
        jvmArgs(extra)
    }
    outputs.upToDateWhen { false }
    testLogging {
        events("passed", "failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        showStandardStreams = true
    }
}
