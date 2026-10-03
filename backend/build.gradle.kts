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
    implementation("com.github.jsqlparser:jsqlparser:5.3")
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
// Explicit opt-in gate: requires installed frontend dependencies and local Playwright Chromium.
tasks.test { exclude("**/SnapshotSourceContractIntegrationTest.class") }
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
