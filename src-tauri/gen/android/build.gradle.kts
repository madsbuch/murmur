buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:9.3.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.10")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
    // The official Tauri scanner defaults to a model downloaded by Play Services.
    // Bundle the API-compatible detector so first-run QR scans also work offline.
    configurations.configureEach {
        withDependencies {
            val downloadedDetector = filter {
                it.group == "com.google.android.gms" && it.name == "play-services-mlkit-barcode-scanning"
            }
            if (downloadedDetector.isNotEmpty()) {
                removeAll(downloadedDetector.toSet())
                add(project.dependencies.create("com.google.mlkit:barcode-scanning:17.3.0"))
            }
        }
    }
}

tasks.register("clean").configure {
    delete("build")
}
