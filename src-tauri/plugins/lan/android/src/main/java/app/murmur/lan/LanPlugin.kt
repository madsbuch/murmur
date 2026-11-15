package app.murmur.lan

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import java.util.ArrayDeque
import java.net.Inet6Address
import java.net.InetAddress

@InvokeArg
class LanConfig {
    lateinit var serviceName: String
    lateinit var networkId: String
    lateinit var deviceId: String
    var port: Int = 0
}

@InvokeArg
class StartArgs { lateinit var config: LanConfig }

/** Native NSD avoids implementing Android's multicast/network lifecycle in Rust. */
@TauriPlugin(permissions = [Permission(strings = ["android.permission.ACCESS_LOCAL_NETWORK"], alias = "localNetwork")])
class LanPlugin(private val activity: Activity) : Plugin(activity) {
    private val main = Handler(Looper.getMainLooper())
    private val nsd = activity.getSystemService(Context.NSD_SERVICE) as NsdManager
    private var desired: LanConfig? = null
    private var registration: NsdManager.RegistrationListener? = null
    private var discovery: NsdManager.DiscoveryListener? = null
    private var multicast: WifiManager.MulticastLock? = null
    private val services = mutableMapOf<String, NsdServiceInfo>()
    private val queue = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private var generation = 0

    private val refresh = object : Runnable {
        override fun run() {
            if (desired == null) return
            if (discovery == null || registration == null) restart()
            else {
                services.values.forEach { enqueue(it) }
                main.postDelayed(this, 15_000)
            }
        }
    }

    @Command
    fun start(invoke: Invoke) {
        if (Build.VERSION.SDK_INT >= 37 && activity.applicationInfo.targetSdkVersion >= 37 &&
            activity.checkSelfPermission("android.permission.ACCESS_LOCAL_NETWORK") != PackageManager.PERMISSION_GRANTED) {
            requestPermissionForAlias("localNetwork", invoke, "localNetworkPermission")
            return
        }
        val config = invoke.parseArgs(StartArgs::class.java).config
        desired = config
        restart()
        invoke.resolve()
    }

    @PermissionCallback
    private fun localNetworkPermission(invoke: Invoke) {
        if (activity.checkSelfPermission("android.permission.ACCESS_LOCAL_NETWORK") == PackageManager.PERMISSION_GRANTED) start(invoke)
        else invoke.reject("Allow local network access in Settings to discover nearby devices.")
    }

    @Command
    fun stop(invoke: Invoke) {
        desired = null
        stopNative()
        invoke.resolve()
    }

    override fun onPause() { stopNative() }
    override fun onResume() { if (desired != null) restart() }
    override fun onDestroy() { desired = null; stopNative() }

    private fun error(message: String) {
        val payload = JSObject()
        payload.put("message", message)
        trigger("error", payload)
    }

    private fun restart() {
        stopNative()
        val config = desired ?: return
        val epoch = generation
        try {
            // Older Android versions need this even with NsdManager. Release on pause.
            val wifi = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            multicast = wifi.createMulticastLock("murmur-discovery").also { it.setReferenceCounted(false); it.acquire() }
            val service = NsdServiceInfo().apply {
                serviceName = config.serviceName
                serviceType = "_murmur._tcp."
                port = config.port
                setAttribute("network", config.networkId)
                setAttribute("device", config.deviceId)
                setAttribute("v", "1")
            }
            val advertiser = object : NsdManager.RegistrationListener {
                override fun onServiceRegistered(info: NsdServiceInfo) {}
                override fun onServiceUnregistered(info: NsdServiceInfo) {}
                override fun onRegistrationFailed(info: NsdServiceInfo, code: Int) { main.post {
                    if (epoch == generation) { registration = null; error("LAN advertising failed ($code). Retrying shortly.") }
                } }
                override fun onUnregistrationFailed(info: NsdServiceInfo, code: Int) {}
            }
            registration = advertiser
            nsd.registerService(service, NsdManager.PROTOCOL_DNS_SD, advertiser)
            val browser = object : NsdManager.DiscoveryListener {
                override fun onDiscoveryStarted(type: String) {}
                override fun onDiscoveryStopped(type: String) {}
                override fun onServiceFound(info: NsdServiceInfo) { main.post {
                    if (epoch == generation) { services[info.serviceName] = info; enqueue(info) }
                } }
                override fun onServiceLost(info: NsdServiceInfo) { main.post { if (epoch == generation) services.remove(info.serviceName) } }
                override fun onStartDiscoveryFailed(type: String, code: Int) { main.post {
                    if (epoch == generation) { error("LAN discovery failed ($code). Retrying shortly."); stopNative(); main.postDelayed(refresh, 5_000) }
                } }
                override fun onStopDiscoveryFailed(type: String, code: Int) {}
            }
            discovery = browser
            nsd.discoverServices("_murmur._tcp.", NsdManager.PROTOCOL_DNS_SD, browser)
            main.postDelayed(refresh, 15_000)
        } catch (e: Exception) {
            error(e.message ?: "LAN discovery could not start.")
            stopNative()
            main.postDelayed(refresh, 5_000)
        }
    }

    private fun stopNative() {
        generation++
        main.removeCallbacks(refresh)
        discovery?.let { try { nsd.stopServiceDiscovery(it) } catch (_: Exception) {} }
        registration?.let { try { nsd.unregisterService(it) } catch (_: Exception) {} }
        discovery = null
        registration = null
        services.clear()
        queue.clear()
        resolving = false
        multicast?.let { if (it.isHeld) it.release() }
        multicast = null
    }

    private fun enqueue(info: NsdServiceInfo) {
        if (queue.none { it.serviceName == info.serviceName }) queue.add(info)
        resolveNext()
    }

    private fun numericAddress(address: InetAddress): String? {
        val host = address.hostAddress?.substringBefore('%') ?: return null
        return if (address is Inet6Address && address.isLinkLocalAddress && address.scopeId != 0)
            "$host%${address.scopeId}" else host
    }

    @Suppress("DEPRECATION")
    private fun resolveNext() {
        if (resolving || queue.isEmpty()) return
        val info = queue.removeFirst()
        val epoch = generation
        resolving = true
        // Serialize for Android versions which allow only one resolve operation.
        try { nsd.resolveService(info, object : NsdManager.ResolveListener {
            override fun onResolveFailed(service: NsdServiceInfo, code: Int) { main.post {
                if (epoch == generation) { resolving = false; resolveNext() }
            } }
            override fun onServiceResolved(service: NsdServiceInfo) { main.post {
                if (epoch != generation) return@post
                resolving = false
                val config = desired
                val network = service.attributes["network"]?.toString(Charsets.UTF_8)
                val device = service.attributes["device"]?.toString(Charsets.UTF_8)
                if (config != null && network == config.networkId && !device.isNullOrEmpty() && device != config.deviceId) {
                    val addresses = if (Build.VERSION.SDK_INT >= 34) service.hostAddresses.mapNotNull { numericAddress(it) }
                        else listOfNotNull(service.host?.let { numericAddress(it) })
                    if (addresses.isNotEmpty()) {
                        val payload = JSObject()
                        payload.put("deviceId", device)
                        payload.put("networkId", network)
                        payload.put("addresses", JSONArray(addresses))
                        payload.put("port", service.port)
                        trigger("peer", payload)
                    }
                }
                resolveNext()
            } }
        }) } catch (_: Exception) { resolving = false; resolveNext() }
    }
}
