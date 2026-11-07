import java.util.Base64

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Build channel. "dev" (the default) is for branch builds signed with the dev key: it gets the
// application ID suffix ".dev" and the label "Tunnelview Dev", so it installs next to the
// release app. "release" is for tags v* only. CI passes the same value twice:
//   Gradle: -PtunnelviewChannel=<ch> (as ORG_GRADLE_PROJECT_tunnelviewChannel)
//   Dart:   --dart-define=TUNNELVIEW_CHANNEL=<ch>
val tunnelviewChannel: String = (findProperty("tunnelviewChannel") as String?) ?: "dev"
require(tunnelviewChannel == "dev" || tunnelviewChannel == "release") {
    "tunnelviewChannel must be 'dev' or 'release', got '$tunnelviewChannel'"
}

// The Flutter tool passes --dart-define values as -Pdart-defines=<base64>,<base64>,...
// A release build must also tell the Dart side it is a release build.
val dartDefinesProperty = findProperty("dart-defines") as String?
if (dartDefinesProperty != null) {
    val dartChannel =
        dartDefinesProperty
            .split(",")
            .filter { it.isNotEmpty() }
            .map { String(Base64.getDecoder().decode(it), Charsets.UTF_8) }
            .firstOrNull { it.startsWith("TUNNELVIEW_CHANNEL=") }
            ?.substringAfter("=")
    require(dartChannel == tunnelviewChannel || (dartChannel == null && tunnelviewChannel == "dev")) {
        "--dart-define=TUNNELVIEW_CHANNEL=$dartChannel does not match -PtunnelviewChannel=$tunnelviewChannel"
    }
}

android {
    namespace = "io.github.naminaone99.tunnelview"
    compileSdk = flutter.compileSdkVersion
    // Preinstalled on ubuntu-latest; Flutter's default (28.2) would be downloaded on every build.
    // flutter_zxing already links with 16 KB page alignment on NDK 27.
    ndkVersion = "27.3.13750724"

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "io.github.naminaone99.tunnelview"
        minSdk = flutter.minSdkVersion
        // Pinned to 36: at target 37, Android 17 blocks local-network access by default, which
        // must be tested over the Tailscale VPN first.
        targetSdk = 36
        // From --build-name / --build-number (see .github/workflows/android.yml).
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        if (tunnelviewChannel == "dev") {
            applicationIdSuffix = ".dev"
        }
        manifestPlaceholders["appLabel"] = if (tunnelviewChannel == "dev") "Tunnelview Dev" else "Tunnelview"
    }

    buildTypes {
        release {
            // No signing here. CI builds an UNSIGNED APK in a job without secrets and signs it
            // in a separate job with apksigner. Never sign a release build with the debug key.
            signingConfig = null
            isMinifyEnabled = true
            isShrinkResources = true
            isDebuggable = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    packaging {
        jniLibs {
            // Native libraries stay uncompressed and page-aligned (16 KB pages, Android 15+).
            useLegacyPackaging = false
        }
    }

    // No Google-encrypted dependency report inside the APK.
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
