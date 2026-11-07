package io.github.naminaone99.tunnelview

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * Small UI helpers the Flutter framework does not offer. Dart side: lib/platform/ui_platform.dart.
 *
 * - copySensitive(label, text): puts plain text on the clipboard marked sensitive
 *   (ClipDescription.EXTRA_IS_SENSITIVE; the same key as a literal below API 33), so Android 13+
 *   hides the copy preview and keyboards that honour the flag keep it out of their clipboard
 *   history (security.md §8.4). Flutter's Clipboard.setData cannot set this flag.
 *
 * Nothing here logs the text.
 */
class UiPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    companion object {
        private const val METHOD_CHANNEL = "io.github.naminaone99.tunnelview/ui"
        private const val EXTRA_IS_SENSITIVE_LITERAL = "android.content.extra.IS_SENSITIVE"
        private const val MAX_TEXT = 256 * 1024
    }

    private lateinit var context: Context
    private var methods: MethodChannel? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        methods = MethodChannel(binding.binaryMessenger, METHOD_CHANNEL).also { it.setMethodCallHandler(this) }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methods?.setMethodCallHandler(null)
        methods = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "copySensitive" -> {
                    val label = call.argument<String>("label") ?: "Tunnelview"
                    val text = call.argument<String>("text")
                    if (text == null || text.length > MAX_TEXT) {
                        result.success(false)
                    } else {
                        result.success(copySensitive(label, text))
                    }
                }
                else -> result.notImplemented()
            }
        } catch (e: Exception) {
            // The class name only: a message could contain the text.
            result.error("ui", e.javaClass.simpleName, null)
        }
    }

    private fun copySensitive(label: String, text: String): Boolean {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return false
        val clip = ClipData.newPlainText(label, text)
        val key = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ClipDescription.EXTRA_IS_SENSITIVE
        } else {
            EXTRA_IS_SENSITIVE_LITERAL
        }
        val extras = PersistableBundle()
        extras.putBoolean(key, true)
        clip.description.setExtras(extras)
        clipboard.setPrimaryClip(clip)
        return true
    }
}
