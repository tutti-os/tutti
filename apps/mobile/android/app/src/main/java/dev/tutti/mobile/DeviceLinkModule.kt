package dev.tutti.mobile

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
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
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

class DeviceLinkModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext),
    LifecycleEventListener {
    @Volatile
    private var link: Link? = null
    private var linkGeneration = 0L
    private val backgroundClose = Runnable { closeCurrentLink() }
    private val closeExecutor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private val executor =
        ThreadPoolExecutor(
            2,
            4,
            30,
            TimeUnit.SECONDS,
            ArrayBlockingQueue(16),
            ThreadPoolExecutor.AbortPolicy(),
        )

    init {
        reactContext.addLifecycleEventListener(this)
    }

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
        val generation = beginLinkOperation()
        runAsync(promise, "DEVICE_LINK_PREPARE_FAILED", "Unable to prepare DeviceLink") {
            val prepared = Mobile.newLink(stunEndpointsJSON)
            try {
                val description = prepared.localDescription(timeoutMillis.toLong())
                check(promoteLink(prepared, generation)) {
                    "DeviceLink prepare was cancelled"
                }
                Arguments.createMap().apply {
                    putString("descriptionJSON", description)
                    putDouble("token", generation.toDouble())
                }
            } catch (error: Throwable) {
                closeDetachedLink(prepared)
                throw error
            }
        }
    }

    @ReactMethod
    fun connectLink(
        peerDescriptionJSON: String,
        caller: Boolean,
        token: Double,
        timeoutMillis: Double,
        promise: Promise,
    ) {
        val selected = linkSnapshot(token.toLong())
        if (selected == null) {
            promise.reject(
                "DEVICE_LINK_CONNECT_FAILED",
                "DeviceLink preparation is no longer current",
            )
            return
        }
        runAsync(promise, "DEVICE_LINK_CONNECT_FAILED", "Unable to connect DeviceLink") {
            selected.connect(peerDescriptionJSON, caller, timeoutMillis.toLong())
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
        val selected = linkSnapshot()
        if (selected == null) {
            promise.reject(
                "DEVICE_LINK_REQUEST_FAILED",
                "DeviceLink is not prepared",
            )
            return
        }
        runAsync(promise, "DEVICE_LINK_REQUEST_FAILED", "DeviceLink request failed") {
            val timeout = timeoutMillis.toLong().coerceAtLeast(1)
            val deadline = SystemClock.elapsedRealtime() + timeout
            val stream = selected.openStream(timeout)
            try {
                stream.setDeadline(
                    (deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1),
                )
                val requestID = UUID.randomUUID().toString()
                val bodyBytes = body.toByteArray(StandardCharsets.UTF_8)
                require(bodyBytes.size <= MAX_REQUEST_BODY_BYTES) {
                    "DeviceLink request body exceeds $MAX_REQUEST_BODY_BYTES bytes"
                }
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
                                bodyBytes,
                                Base64.NO_WRAP,
                            ),
                        ).toString()
                val payload = request.toByteArray(StandardCharsets.UTF_8)
                require(payload.size <= MAX_REQUEST_FRAME_BYTES) {
                    "DeviceLink request exceeds $MAX_REQUEST_FRAME_BYTES bytes"
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
                require(responseSize in 1..MAX_RESPONSE_FRAME_BYTES) {
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
                    putMap("headers", responseHeaders(response.optJSONObject("headers")))
                }
            } finally {
                runCatching(stream::close)
            }
        }
    }

    @ReactMethod
    fun closeLink(promise: Promise) {
        closeCurrentLink()
        promise.resolve(null)
    }

    override fun onHostResume() {
        handler.removeCallbacks(backgroundClose)
    }

    override fun onHostPause() {
        handler.removeCallbacks(backgroundClose)
        handler.postDelayed(backgroundClose, BACKGROUND_GRACE_MILLIS)
    }

    override fun onHostDestroy() {
        handler.removeCallbacks(backgroundClose)
        closeCurrentLink()
    }

    override fun invalidate() {
        handler.removeCallbacks(backgroundClose)
        reactApplicationContext.removeLifecycleEventListener(this)
        closeCurrentLink()
        executor.shutdownNow()
        closeExecutor.shutdown()
        super.invalidate()
    }

    @Synchronized
    private fun beginLinkOperation(): Long {
        linkGeneration += 1
        return linkGeneration
    }

    @Synchronized
    private fun promoteLink(
        next: Link,
        generation: Long,
    ): Boolean {
        if (generation != linkGeneration) {
            return false
        }
        val previous = link
        link = next
        if (previous != null && previous !== next) {
            closeDetachedLink(previous)
        }
        return true
    }

    @Synchronized
    private fun linkSnapshot(): Link? = link

    @Synchronized
    private fun linkSnapshot(generation: Long): Link? =
        if (generation == linkGeneration) link else null

    private fun closeCurrentLink() {
        val previous =
            synchronized(this) {
                linkGeneration += 1
                val detached = link
                link = null
                detached
            }
        closeDetachedLink(previous)
    }

    private fun closeDetachedLink(detached: Link?) {
        if (detached == null) {
            return
        }
        try {
            closeExecutor.execute {
                runCatching(detached::close)
            }
        } catch (_: RejectedExecutionException) {
            runCatching(detached::close)
        }
    }

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

    private fun responseHeaders(headers: JSONObject?) =
        Arguments.createMap().apply {
            if (headers == null) {
                return@apply
            }
            for (name in headers.keys()) {
                val values = headers.optJSONArray(name) ?: continue
                val array = Arguments.createArray()
                for (index in 0 until values.length()) {
                    array.pushString(values.optString(index))
                }
                putArray(name, array)
            }
        }

    private fun runAsync(
        promise: Promise,
        code: String,
        message: String,
        operation: () -> Any?,
    ) {
        try {
            executor.execute {
                runCatching(operation).fold(promise::resolve) {
                    promise.reject(code, message, it)
                }
            }
        } catch (error: RejectedExecutionException) {
            promise.reject(code, "DeviceLink is busy; try again", error)
        }
    }

    companion object {
        private const val BACKGROUND_GRACE_MILLIS = 15_000L
        private const val MAX_READ_CHUNK = 1 shl 20
        private const val MAX_REQUEST_BODY_BYTES = 8 shl 20
        private const val MAX_RESPONSE_BODY_BYTES = 16 shl 20
        private const val FRAME_ENVELOPE_BYTES = 1 shl 20
        private const val MAX_REQUEST_FRAME_BYTES =
            ((MAX_REQUEST_BODY_BYTES + 2) / 3 * 4) + FRAME_ENVELOPE_BYTES
        private const val MAX_RESPONSE_FRAME_BYTES =
            ((MAX_RESPONSE_BODY_BYTES + 2) / 3 * 4) + FRAME_ENVELOPE_BYTES
    }
}
