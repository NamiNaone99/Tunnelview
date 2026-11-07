package io.github.naminaone99.tunnelview

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine

/**
 * The only activity. FlutterFragmentActivity, because local_auth's BiometricPrompt needs a
 * FragmentActivity.
 *
 * Hardening:
 * - FLAG_SECURE: no screenshots, screen recording or casting of any Tunnelview screen, and a
 *   blank Recents thumbnail;
 * - setRecentsScreenshotEnabled(false) on API 33+;
 * - filterTouchesWhenObscured: touches are dropped while another app's window covers this one
 *   (tapjacking), on the whole view tree including the FlutterView;
 * - no input from other apps: this activity is exported (it is the launcher), so any installed
 *   app can start it with an explicit Intent carrying a data URI and extras. FlutterFragmentActivity
 *   would read them (a route, background_mode, cached_engine_id, dart_entrypoint_args through
 *   Java deserialization, shell flags). The launch Intent and every new Intent are replaced with
 *   a plain MAIN Intent before Flutter sees them, deep linking is off here and in the manifest
 *   (flutter_deeplinking_enabled=false), and the initial route is always "/".
 *
 * In-app native code: [TailnetPlugin] (Tailscale detection and process binding) and [UiPlugin]
 * (clipboard writes marked sensitive).
 */
class MainActivity : FlutterFragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        // Replaced without reading it: its extras are never unparcelled.
        intent = plainIntent()
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            setRecentsScreenshotEnabled(false)
        }
        filterTouchesWhenObscured(window.decorView)
    }

    // singleTop: a later explicit Intent arrives here. Flutter (and its plugins) only ever see a
    // plain MAIN Intent, so no URI is pushed as a route.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(plainIntent())
    }

    override fun shouldHandleDeeplinking(): Boolean = false

    override fun getInitialRoute(): String = "/"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        flutterEngine.plugins.add(TailnetPlugin())
        flutterEngine.plugins.add(UiPlugin())
    }

    override fun onPostResume() {
        super.onPostResume()
        // The FlutterView is created by the FlutterFragment after onCreate.
        filterTouchesWhenObscured(window.decorView)
    }

    private fun plainIntent(): Intent =
        Intent(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .setClass(this, MainActivity::class.java)

    private fun filterTouchesWhenObscured(view: View) {
        view.filterTouchesWhenObscured = true
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) {
                filterTouchesWhenObscured(view.getChildAt(i))
            }
        }
    }
}
