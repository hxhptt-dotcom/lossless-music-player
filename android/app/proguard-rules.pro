# Keep JavaScriptInterface bridge methods intact
-keepclassmembers class com.lossless.musicplayer.MainActivity$AndroidBridge {
    @android.webkit.JavascriptInterface <methods>;
}
