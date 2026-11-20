plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "tv.pqtv.player"
    compileSdk = 34

    defaultConfig {
        applicationId = "tv.pqtv.player"
        minSdk = 23
        targetSdk = 34
        val injectedCode = (project.findProperty("PQTV_VERSION_CODE") as String?)?.toIntOrNull()
            ?: (project.findProperty("android.injected.version.code") as String?)?.toIntOrNull()
            ?: 1
        val injectedName = (project.findProperty("PQTV_VERSION_NAME") as String?)?.takeIf { it.isNotBlank() }
            ?: (project.findProperty("android.injected.version.name") as String?)?.takeIf { it.isNotBlank() }
            ?: "1.0.0"

        versionCode = injectedCode
        versionName = injectedName

        val serverUrl = (project.findProperty("PQTV_SERVER_URL") as String?) ?: "__PQTV_SERVER_URL__"
        buildConfigField("String", "PQTV_SERVER_URL", "\"$serverUrl\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Sign with debug key by default so CI APKs install cleanly out of the box
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
}
