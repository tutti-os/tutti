package dev.tutti.mobile

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import dev.tutti.devicelink.mobile.Mobile

class DeviceLinkModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    override fun getName(): String = "TuttiDeviceLink"

    @ReactMethod
    fun probeEpoch(promise: Promise) {
        runCatching(Mobile::probeEpoch).fold(promise::resolve) {
            promise.reject("DEVICE_LINK_UNAVAILABLE", "Unable to read DeviceLink epoch", it)
        }
    }

    @ReactMethod
    fun runLoopbackProbe(timeoutMillis: Double, promise: Promise) {
        Thread {
            runCatching {
                Mobile.runLoopbackProbe(timeoutMillis.toLong())
            }.fold(promise::resolve) {
                promise.reject("DEVICE_LINK_PROBE_FAILED", "DeviceLink probe failed", it)
            }
        }.start()
    }
}
