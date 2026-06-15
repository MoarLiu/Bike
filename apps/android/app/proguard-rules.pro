# Keep Kotlin metadata and annotations used by kotlinx.serialization.
-keepattributes *Annotation*,InnerClasses,EnclosingMethod,Signature
-keep class kotlin.Metadata { *; }

# Keep generated serializers and serializer lookup entry points for release/R8 builds.
-keep class **$$serializer { *; }
-keepclassmembers class ** {
    public static ** serializer(...);
}
-keepclassmembers class ** {
    *** Companion;
}

# The workspace JSON model is a persisted cross-platform file format.
-keep @kotlinx.serialization.Serializable class com.bike.android.data.** { *; }
