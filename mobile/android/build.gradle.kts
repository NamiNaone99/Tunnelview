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

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
