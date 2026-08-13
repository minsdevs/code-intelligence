plugins {
    // Auto-provisions the Java 21 toolchain when only a newer JDK is installed locally.
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

rootProject.name = "backend"
