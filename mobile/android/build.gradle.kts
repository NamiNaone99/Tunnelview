allprojects {
    repositories {
        // flutter_webrtc depends on com.github.davidliu:audioswitch, which only exists on JitPack
        // (built on demand, unsigned). The vendored copy is the only source for that group
        // (see vendor-maven/README.md); gradle/verification-metadata.xml pins its SHA-256.
        exclusiveContent {
            forRepository {
                maven {
                    name = "tunnelviewVendor"
                    url = uri(rootProject.file("vendor-maven"))
                }
            }
            filter {
                includeGroup("com.github.davidliu")
            }
        }
        google()
        mavenCentral()
    }
    // Plugins add https://jitpack.io to every project (flutter_webrtc does). Never resolve
    // anything from it.
    repositories.withType<MavenArtifactRepository>().configureEach {
        if (url.host == "jitpack.io") {
            content {
                excludeGroupByRegex(".*")
            }
        }
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

// Plugins with native code (flutter_zxing, jni) build with the plugin project's NDK and CMake.
// Left alone, those are AGP's or Flutter's defaults (NDK 28.2, CMake 3.22.1), which the CI
// runner does not have, so every build would download them. Use the preinstalled ones, like
// the app does. finalizeDsl runs after the plugin's own build script (jni sets ndkVersion).
subprojects {
    plugins.withId("com.android.library") {
        extensions.getByName("androidComponents").withGroovyBuilder {
            "finalizeDsl"(
                Action<Any> {
                    withGroovyBuilder {
                        "setNdkVersion"("27.3.13750724")
                        "externalNativeBuild" {
                            "cmake" {
                                "setVersion"("3.31.5")
                            }
                        }
                    }
                },
            )
        }
    }
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
