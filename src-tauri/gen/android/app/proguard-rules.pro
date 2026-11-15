# ML Kit discovers these registrars by manifest name and constructs them through
# reflection. Its transitive firebase-components 16.1.0 rules keep the classes
# but omit their constructors, which R8 full mode removes. The release scanner
# then crashes in BarcodeScanning.getClient() immediately after camera permission.
# Match the constructor rule in current firebase-components:
# https://github.com/firebase/firebase-android-sdk/blob/main/firebase-components/proguard.txt
-keep class * implements com.google.firebase.components.ComponentRegistrar {
    public <init>();
}
-keep,allowshrinking interface com.google.firebase.components.ComponentRegistrar
