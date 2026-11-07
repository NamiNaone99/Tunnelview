package io.github.naminaone99.tunnelview

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.RouteInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.net.Inet6Address
import java.net.InetAddress

/**
 * Finds the Tailscale tunnel and keeps the whole process bound to it (PLAN §6.1-6.2, DECISIONS
 * M-S1). Dart side: lib/platform/tailnet.dart; map format: lib/platform/tailnet_platform.dart.
 *
 * - snapshot: every network (VPN flag, transports, addresses, routes with interface and prefix,
 *   DNS servers), the chosen tailnet network and the binding. The tailnet network is exactly one
 *   TRANSPORT_VPN network carrying an fd7a:115c:a1e0::/48 address; otherwise the reason is
 *   "none" (no VPN), "no-fd7a" (a VPN without a Tailscale address) or "several".
 * - binding: whenever a new tailnet Network object is chosen, the process is bound to it with
 *   ConnectivityManager.bindProcessToNetwork, for the rest of the process lifetime. It is never
 *   unbound: when that network disappears, sockets fail instead of falling back to Wi-Fi or
 *   mobile data. A refused bind (false) means the VPN does not apply to this app, i.e.
 *   Tunnelview is excluded from Tailscale (split tunnelling). bindProcessToNetwork needs no
 *   permission, so CHANGE_NETWORK_STATE stays removed from the manifest.
 * - events: a NetworkCallback (onAvailable, onLost, onCapabilitiesChanged,
 *   onLinkPropertiesChanged) re-evaluates, rebinds and sends a fresh snapshot.
 * - routeCovers: a non-default route (prefix > 0) on the tunnel interface covers the target.
 * - deviceName, openTailscale.
 *
 * This class never touches the platform's VPN-provider API: that would ask the user to replace
 * Tailscale as the phone's VPN. Nothing here logs addresses.
 */
class TailnetPlugin : FlutterPlugin, MethodChannel.MethodCallHandler, EventChannel.StreamHandler {
    companion object {
        private const val METHOD_CHANNEL = "io.github.naminaone99.tunnelview/tailnet"
        private const val EVENT_CHANNEL = "io.github.naminaone99.tunnelview/tailnet/events"
        private const val TAILSCALE_PACKAGE = "com.tailscale.ipn"
        private val TAILSCALE_V6_PREFIX = byteArrayOf(0xfd.toByte(), 0x7a, 0x11, 0x5c, 0xa1.toByte(), 0xe0.toByte())
        private const val MAX_LOST = 64

        // bindProcessToNetwork is process-wide, so its bookkeeping is too.
        @Volatile private var attemptedHandle: Long? = null
        @Volatile private var attemptOk: Boolean? = null
    }

    private lateinit var context: Context
    private lateinit var cm: ConnectivityManager
    private var methods: MethodChannel? = null
    private var events: EventChannel? = null
    private var sink: EventChannel.EventSink? = null
    private var callback: ConnectivityManager.NetworkCallback? = null
    private val main = Handler(Looper.getMainLooper())

    // Network objects reported lost. A lost network never comes back (a reconnect is a new
    // Network), so it is ignored even if getAllNetworks still lists it for a moment.
    private val lost = LinkedHashSet<Long>()

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        methods = MethodChannel(binding.binaryMessenger, METHOD_CHANNEL).also { it.setMethodCallHandler(this) }
        events = EventChannel(binding.binaryMessenger, EVENT_CHANNEL).also { it.setStreamHandler(this) }
        registerCallback()
        // Bind at once if Tailscale is already up, before any Dart code runs.
        evaluate()
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        unregisterCallback()
        methods?.setMethodCallHandler(null)
        events?.setStreamHandler(null)
        methods = null
        events = null
        sink = null
    }

    // ---- Method channel ------------------------------------------------------------------

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "snapshot" -> result.success(evaluate())
                "bindProcess" -> result.success(bindHandle(handleArg(call)))
                "routeCovers" -> result.success(routeCovers(handleArg(call), bytesArg(call.argument<Any>("address"))))
                "deviceName" -> result.success(deviceName())
                "openTailscale" -> result.success(openTailscale())
                else -> result.notImplemented()
            }
        } catch (e: Exception) {
            // The class name only: messages could contain addresses.
            result.error("tailnet", e.javaClass.simpleName, null)
        }
    }

    private fun handleArg(call: MethodCall): Long? = (call.argument<Any>("handle") as? Number)?.toLong()

    // 4 or 16 address bytes, sent from Dart as a list of ints 0-255 (or a byte array).
    private fun bytesArg(v: Any?): ByteArray? = when (v) {
        is ByteArray -> v
        is List<*> -> {
            val ints = v.map { (it as? Number)?.toInt() ?: -1 }
            if (ints.any { it !in 0..255 }) null else ByteArray(ints.size) { i -> ints[i].toByte() }
        }
        else -> null
    }

    // ---- Event channel -------------------------------------------------------------------

    override fun onListen(arguments: Any?, eventSink: EventChannel.EventSink?) {
        sink = eventSink
        emit("listen", null)
    }

    override fun onCancel(arguments: Any?) {
        sink = null
    }

    private fun emit(kind: String, handle: Long?) {
        val snapshot = evaluate()
        sink?.success(mapOf("kind" to kind, "handle" to handle, "snapshot" to snapshot))
    }

    private fun registerCallback() {
        if (callback != null) return
        // The default request has NOT_VPN; without it the callback also sees VPN networks.
        val request = NetworkRequest.Builder()
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .build()
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = post("available", network, false)

            override fun onLost(network: Network) = post("lost", network, true)

            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) =
                post("capabilities", network, false)

            override fun onLinkPropertiesChanged(network: Network, lp: LinkProperties) =
                post("link-properties", network, false)
        }
        try {
            cm.registerNetworkCallback(request, cb)
            callback = cb
        } catch (e: Exception) {
            // Without callbacks the app still re-checks on resume and on every snapshot.
            callback = null
        }
    }

    private fun unregisterCallback() {
        val cb = callback ?: return
        callback = null
        try {
            cm.unregisterNetworkCallback(cb)
        } catch (e: Exception) {
            // Already unregistered.
        }
    }

    // Callbacks arrive on a ConnectivityManager thread; everything else runs on the main thread.
    private fun post(kind: String, network: Network, isLost: Boolean) {
        val handle = network.networkHandle
        main.post {
            if (isLost) {
                lost.add(handle)
                while (lost.size > MAX_LOST) lost.remove(lost.first())
            } else if (kind == "available") {
                // Android reuses netIds after a while; a network that is available again is new.
                lost.remove(handle)
            }
            emit(kind, handle)
        }
    }

    // ---- Evaluation and binding ----------------------------------------------------------

    private class Seen(val network: Network, val caps: NetworkCapabilities?, val lp: LinkProperties?)

    @Suppress("DEPRECATION") // getAllNetworks: the callback alone gives no initial list.
    private fun currentNetworks(): List<Seen> =
        cm.allNetworks
            .filter { it.networkHandle !in lost }
            .map { Seen(it, cm.getNetworkCapabilities(it), cm.getLinkProperties(it)) }

    private fun isVpn(s: Seen) = s.caps?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true

    private fun chooseTailnet(seen: List<Seen>): Pair<String, Network?> {
        var vpns = 0
        val candidates = ArrayList<Network>()
        for (s in seen) {
            val lp = s.lp ?: continue
            if (!isVpn(s)) continue
            vpns++
            if (lp.linkAddresses.any { isTailscaleV6(it.address) }) candidates.add(s.network)
        }
        return when {
            candidates.size == 1 -> "ok" to candidates[0]
            candidates.size > 1 -> "several" to null
            vpns > 0 -> "no-fd7a" to null
            else -> "none" to null
        }
    }

    private fun evaluate(): Map<String, Any?> {
        val at = SystemClock.elapsedRealtime()
        val seen = currentNetworks()
        val (reason, tailnet) = chooseTailnet(seen)
        if (tailnet != null) bindIfNeeded(tailnet)
        val active = cm.activeNetwork?.networkHandle
        return mapOf(
            "at" to at,
            "sdk" to Build.VERSION.SDK_INT,
            "networks" to seen.map { describe(it, active) },
            "tailnet" to tailnet?.networkHandle,
            "reason" to reason,
            "binding" to bindingMap(),
        )
    }

    private fun bindIfNeeded(network: Network) {
        val handle = network.networkHandle
        if (cm.boundNetworkForProcess?.networkHandle == handle) {
            attemptedHandle = handle
            attemptOk = true
            return
        }
        bind(network)
    }

    private fun bind(network: Network): Boolean {
        val ok = try {
            cm.bindProcessToNetwork(network)
        } catch (e: Exception) {
            false
        }
        attemptedHandle = network.networkHandle
        attemptOk = ok
        return ok
    }

    // Binds explicitly, but only to the network that is the tailnet right now.
    private fun bindHandle(handle: Long?): Boolean {
        if (handle == null) return false
        val (_, tailnet) = chooseTailnet(currentNetworks())
        if (tailnet == null || tailnet.networkHandle != handle) return false
        if (cm.boundNetworkForProcess?.networkHandle == handle) return true
        return bind(tailnet)
    }

    private fun bindingMap(): Map<String, Any?> = mapOf(
        "process" to cm.boundNetworkForProcess?.networkHandle,
        "attempted" to attemptedHandle,
        "ok" to attemptOk,
    )

    // ---- Route check ---------------------------------------------------------------------

    // The target arrives as 4 or 16 bytes: no string parsing, so no DNS lookup is possible.
    private fun routeCovers(handle: Long?, address: ByteArray?): Boolean {
        if (handle == null || address == null || (address.size != 4 && address.size != 16)) return false
        val (_, tailnet) = chooseTailnet(currentNetworks())
        if (tailnet == null || tailnet.networkHandle != handle) return false
        val lp = cm.getLinkProperties(tailnet) ?: return false
        val tun = lp.interfaceName ?: return false
        val target = InetAddress.getByAddress(address)
        return lp.routes.any { r ->
            r.`interface` == tun &&
                r.destination.prefixLength > 0 &&
                !r.isDefaultRoute &&
                (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || r.type == RouteInfo.RTN_UNICAST) &&
                r.matches(target)
        }
    }

    // ---- Description ---------------------------------------------------------------------

    private fun describe(s: Seen, active: Long?): Map<String, Any?> {
        val caps = s.caps
        val lp = s.lp
        return mapOf(
            "handle" to s.network.networkHandle,
            "isVpn" to isVpn(s),
            "transports" to transports(caps),
            "validated" to (caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true),
            "isActive" to (s.network.networkHandle == active),
            "hasLinkProperties" to (lp != null),
            "interface" to lp?.interfaceName,
            "addresses" to (lp?.linkAddresses?.map {
                mapOf("address" to hostString(it.address), "prefix" to it.prefixLength)
            } ?: emptyList<Map<String, Any?>>()),
            "routes" to (lp?.routes?.map { route(it) } ?: emptyList<Map<String, Any?>>()),
            "dns" to (lp?.dnsServers?.map { hostString(it) } ?: emptyList<String>()),
        )
    }

    private fun route(r: RouteInfo): Map<String, Any?> = mapOf(
        "destination" to hostString(r.destination.address),
        "prefix" to r.destination.prefixLength,
        "gateway" to r.gateway?.let { hostString(it) },
        "interface" to r.`interface`,
        "isDefault" to r.isDefaultRoute,
        "type" to (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) r.type else null),
    )

    private fun transports(caps: NetworkCapabilities?): List<String> {
        if (caps == null) return emptyList()
        val names = listOf(
            0 to "cellular", 1 to "wifi", 2 to "bluetooth", 3 to "ethernet", 4 to "vpn",
            5 to "wifi-aware", 6 to "lowpan", 7 to "test", 8 to "usb", 9 to "thread", 10 to "satellite",
        )
        return names.filter { caps.hasTransport(it.first) }.map { it.second }
    }

    private fun hostString(a: InetAddress): String = (a.hostAddress ?: "").substringBefore('%')

    private fun isTailscaleV6(a: InetAddress): Boolean {
        if (a !is Inet6Address) return false
        val b = a.address
        if (b.size != 16) return false
        for (i in TAILSCALE_V6_PREFIX.indices) if (b[i] != TAILSCALE_V6_PREFIX[i]) return false
        return true
    }

    // ---- Device name and Tailscale -------------------------------------------------------

    private fun deviceName(): String {
        val name = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N_MR1) {
            Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)
        } else {
            null
        }
        return if (name.isNullOrBlank()) Build.MODEL ?: "" else name
    }

    private fun openTailscale(): String {
        val intent = context.packageManager.getLaunchIntentForPackage(TAILSCALE_PACKAGE) ?: return "not-installed"
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(intent)
            "opened"
        } catch (e: Exception) {
            "failed"
        }
    }
}
