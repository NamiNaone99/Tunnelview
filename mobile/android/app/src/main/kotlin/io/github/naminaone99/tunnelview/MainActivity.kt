package io.github.naminaone99.tunnelview

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
 *   (tapjacking), on the whole view tree including the FlutterView.
 *
 * In-app native code: [TailnetPlugin] (Tailscale detection and process binding).
 */
class MainActivity : FlutterFragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            setRecentsScreenshotEnabled(false)
        }
        filterTouchesWhenObscured(window.decorView)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        flutterEngine.plugins.add(TailnetPlugin())
    }

    override fun onPostResume() {
        super.onPostResume()
        // The FlutterView is created by the FlutterFragment after onCreate.
        filterTouchesWhenObscured(window.decorView)
    }

    private fun filterTouchesWhenObscured(view: View) {
        view.filterTouchesWhenObscured = true
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) {
                filterTouchesWhenObscured(view.getChildAt(i))
            }
        }
    }
}
