package dev.tutti.mobile

import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import dev.tutti.devicelink.mobile.Link
import dev.tutti.devicelink.mobile.Mobile
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

class DeviceLinkModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    @Volatile
    private var link: Link? = null

    override fun getName(): String = "TuttiDeviceLink"

    @ReactMethod
    fun probeEpoch(promise: Promise) {
        runCatching(Mobile::probeEpoch).fold(promise::resolve) {
            promise.reject("DEVICE_LINK_UNAVAILABLE", "Unable to read DeviceLink epoch", it)
        }
    }

    @ReactMethod
    fun runLoopbackProbe(timeoutMillis: Double, promise: Promise) {
        runAsync(promise, "DEVICE_LINK_PROBE_FAILED", "DeviceLink probe failed") {
            Mobile.runLoopbackProbe(timeoutMillis.toLong())
        }
    }

    @ReactMethod
    fun protocolEpoch(promise: Promise) {
        runCatching(Mobile::protocolEpoch).fold(promise::resolve) {
            promise.reject("DEVICE_LINK_UNAVAILABLE", "Unable to read DeviceLink protocol epoch", it)
        }
    }

    @ReactMethod
    fun prepareLink(
        stunEndpointsJSON: String,
        timeoutMillis: Double,
        promise: Promise,
    ) {
        runAsync(promise, "DEVICE_LINK_PREPARE_FAILED", "Unable to prepare DeviceLink") {
            val prepared = Mobile.newLink(stunEndpointsJSON)
            runCatching {
                prepared.localDescription(timeoutMillis.toLong())
            }.onFailure {
                runCatching(prepared::close)
            }.getOrThrow().also {
                replaceLink(prepared)
            }
        }
    }

    @ReactMethod
    fun connectLink(
        peerDescriptionJSON: String,
        caller: Boolean,
        timeoutMillis: Double,
        promise: Promise,
    ) {
        runAsync(promise, "DEVICE_LINK_CONNECT_FAILED", "Unable to connect DeviceLink") {
            requireLink().connect(peerDescriptionJSON, caller, timeoutMillis.toLong())
        }
    }

    @ReactMethod
    fun requestAgentHTTP(
        method: String,
        path: String,
        body: String,
        timeoutMillis: Double,
        promise: Promise,
    ) {
        runAsync(promise, "DEVICE_LINK_REQUEST_FAILED", "DeviceLink request failed") {
            val stream = requireLink().openStream(timeoutMillis.toLong())
            try {
                val requestID = UUID.randomUUID().toString()
                val request =
                    JSONObject()
                        .put("protocolEpoch", Mobile.protocolEpoch())
                        .put("service", "agent_http")
                        .put("requestId", requestID)
                        .put("method", method)
                        .put("path", path)
                        .put(
                            "headers",
                            JSONObject()
                                .put("Accept", JSONArray().put("application/json"))
                                .put("Content-Type", JSONArray().put("application/json")),
                        ).put(
                            "body",
                            Base64.encodeToString(
                                body.toByteArray(StandardCharsets.UTF_8),
                                Base64.NO_WRAP,
                            ),
                        ).toString()
                val payload = request.toByteArray(StandardCharsets.UTF_8)
                require(payload.size <= MAX_REQUEST_BYTES) {
                    "DeviceLink request exceeds $MAX_REQUEST_BYTES bytes"
                }
                val framed =
                    ByteBuffer
                        .allocate(Int.SIZE_BYTES + payload.size)
                        .order(ByteOrder.BIG_ENDIAN)
                        .putInt(payload.size)
                        .put(payload)
                        .array()
                writeFully(stream, framed)
                val header = readFully(stream, Int.SIZE_BYTES)
                val responseSize = ByteBuffer.wrap(header).order(ByteOrder.BIG_ENDIAN).int
                require(responseSize in 1..MAX_RESPONSE_BYTES) {
                    "DeviceLink response size is invalid"
                }
                val response =
                    JSONObject(
                        String(
                            readFully(stream, responseSize),
                            StandardCharsets.UTF_8,
                        ),
                    )
                require(response.optString("requestId") == requestID) {
                    "DeviceLink response request id does not match"
                }
                val responseBody =
                    response
                        .optString("body")
                        .takeIf(String::isNotEmpty)
                        ?.let { encoded ->
                            String(Base64.decode(encoded, Base64.DEFAULT), StandardCharsets.UTF_8)
                        }.orEmpty()
                Arguments.createMap().apply {
                    putInt("protocolEpoch", response.optInt("protocolEpoch"))
                    putInt("status", response.optInt("status"))
                    putString("body", responseBody)
                    putString("errorCode", response.optString("errorCode"))
                }
            } finally {
                runCatching(stream::close)
            }
        }
    }

    @ReactMethod
    fun closeLink(promise: Promise) {
        runAsync(promise, "DEVICE_LINK_CLOSE_FAILED", "Unable to close DeviceLink") {
            replaceLink(null)
            null
        }
    }

    @Synchronized
    private fun replaceLink(next: Link?) {
        val previous = link
        link = next
        if (previous != null && previous !== next) {
            previous.close()
        }
    }

    private fun requireLink(): Link = link ?: error("DeviceLink is not prepared")

    private fun writeFully(
        stream: dev.tutti.devicelink.mobile.Stream,
        payload: ByteArray,
    ) {
        var offset = 0
        while (offset < payload.size) {
            val chunk = if (offset == 0) payload else payload.copyOfRange(offset, payload.size)
            val written = stream.write(chunk).toInt()
            require(written > 0 && written <= chunk.size) {
                "DeviceLink stream returned an invalid write count"
            }
            offset += written
        }
    }

    private fun readFully(
        stream: dev.tutti.devicelink.mobile.Stream,
        size: Int,
    ): ByteArray {
        val output = ByteArrayOutputStream(size)
        while (output.size() < size) {
            val remaining = size - output.size()
            val chunk = stream.read(minOf(remaining, MAX_READ_CHUNK).toLong())
            require(chunk.isNotEmpty()) { "DeviceLink stream closed before the response completed" }
            output.write(chunk)
        }
        return output.toByteArray()
    }

    private fun runAsync(
        promise: Promise,
        code: String,
        message: String,
        operation: () -> Any?,
    ) {
        Thread {
            runCatching(operation).fold(promise::resolve) {
                promise.reject(code, message, it)
            }
        }.start()
    }

    companion object {
        private const val MAX_READ_CHUNK = 1 shl 20
        private const val MAX_REQUEST_BYTES = 8 shl 20
        private const val MAX_RESPONSE_BYTES = 17 shl 20
    }
}
