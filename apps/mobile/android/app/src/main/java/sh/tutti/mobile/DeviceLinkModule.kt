package sh.tutti.mobile

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.modules.core.DeviceEventManagerModule
import sh.tutti.mobile.bindings.liveprotocolmobile.Liveprotocolmobile
import sh.tutti.mobile.bindings.mobile.Link
import sh.tutti.mobile.bindings.mobile.Mobile
import sh.tutti.mobile.bindings.mobile.Stream
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import org.json.JSONArray
import org.json.JSONObject

class DeviceLinkModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext),
    LifecycleEventListener,
    DefaultLifecycleObserver {
    @Volatile
    private var link: Link? = null
    @Volatile
    private var agentLiveStream: Stream? = null
    @Volatile
    private var relayConfig: RelayConfig? = null
    private var linkGeneration = 0L
    private var agentLiveGeneration = 0L
    private val backgroundClose = Runnable { closeCurrentLink() }
    private val agentLiveExecutor = Executors.newSingleThreadExecutor()
    private val closeExecutor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private val processLifecycle = ProcessLifecycleOwner.get().lifecycle
    @Volatile
    private var invalidated = false
    private val executor = newDeviceLinkOperationExecutor()
    private val candidateExecutor = newDeviceLinkCandidateExecutor()

    init {
        reactContext.addLifecycleEventListener(this)
        UiThreadUtil.runOnUiThread {
            if (!invalidated) {
                processLifecycle.addObserver(this)
            }
        }
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
        _timeoutMillis: Double,
        promise: Promise,
    ) {
        val generation = beginLinkOperation()
        runAsync(promise, "DEVICE_LINK_PREPARE_FAILED", "Unable to prepare DeviceLink") {
            var prepared: Link? = null
            try {
                prepared = Mobile.newLink(stunEndpointsJSON)
                val description = prepared.startLocalDescription()
                check(promoteLink(prepared, generation)) {
                    "DeviceLink prepare was cancelled"
                }
                Arguments.createMap().apply {
                    putString("descriptionJSON", description)
                    putDouble("token", generation.toDouble())
                }
            } catch (error: Throwable) {
                closeDetachedLink(prepared)
                closeDetachedLink(cancelLinkOperation(generation))
                throw error
            }
        }
    }

    @ReactMethod
    fun nextCandidateExchangeAction(
        token: Double,
        timeoutMillis: Double,
        promise: Promise,
    ) {
        val selected = linkSnapshot(token.toLong())
        if (selected == null) {
            promise.reject(
                "DEVICE_LINK_CANDIDATE_FAILED",
                "DeviceLink preparation is no longer current",
            )
            return
        }
        runCandidateAsync(
            promise,
            "DEVICE_LINK_CANDIDATE_FAILED",
            "Unable to read DeviceLink candidate action",
        ) {
            selected.nextCandidateExchangeAction(timeoutMillis.toLong())
        }
    }

    @ReactMethod
    fun resolveCandidateExchangeAction(
        actionId: Double,
        succeeded: Boolean,
        retryable: Boolean,
        candidatesJSON: String,
        token: Double,
        promise: Promise,
    ) {
        val selected = linkSnapshot(token.toLong())
        if (selected == null) {
            promise.reject(
                "DEVICE_LINK_CANDIDATE_FAILED",
                "DeviceLink preparation is no longer current",
            )
            return
        }
        runCandidateAsync(
            promise,
            "DEVICE_LINK_CANDIDATE_FAILED",
            "Unable to resolve DeviceLink candidate action",
        ) {
            selected
                .resolveCandidateExchangeAction(
                    actionId.toLong(),
                    succeeded,
                    retryable,
                    candidatesJSON,
                ).toDouble()
        }
    }

    @ReactMethod
    fun notifyRemoteCandidateChange(
        token: Double,
        promise: Promise,
    ) {
        val selected = linkSnapshot(token.toLong())
        if (selected == null) {
            promise.reject(
                "DEVICE_LINK_CANDIDATE_FAILED",
                "DeviceLink preparation is no longer current",
            )
            return
        }
        runCatching(selected::notifyRemoteCandidateChange).fold(
            { promise.resolve(null) },
            {
                promise.reject(
                    "DEVICE_LINK_CANDIDATE_FAILED",
                    "Unable to notify DeviceLink candidate change",
                    it,
                )
            },
        )
    }

    @ReactMethod
    fun stopCandidateExchange(
        token: Double,
        promise: Promise,
    ) {
        linkSnapshot(token.toLong())?.stopCandidateExchange()
        promise.resolve(null)
    }

    @ReactMethod
    fun cancelLink(
        token: Double,
        promise: Promise,
    ) {
        closeDetachedLink(cancelLinkOperation(token.toLong()))
        promise.resolve(null)
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
    fun configureRelay(
        endpoint: String,
        queryJSON: String,
        headersJSON: String,
        subprotocol: String,
        promise: Promise,
    ) {
        val normalizedEndpoint = endpoint.trim()
        val normalizedSubprotocol = subprotocol.trim()
        if (normalizedEndpoint.isEmpty() || normalizedSubprotocol.isEmpty()) {
            promise.reject(
                "DEVICE_LINK_RELAY_CONFIG_FAILED",
                "Relay endpoint and subprotocol are required",
            )
            return
        }
        synchronized(this) {
            relayConfig = RelayConfig(
                endpoint = normalizedEndpoint,
                queryJSON = queryJSON,
                headersJSON = headersJSON,
                subprotocol = normalizedSubprotocol,
            )
        }
        promise.resolve(null)
    }

    @ReactMethod
    fun probeRelay(timeoutMillis: Double, promise: Promise) {
        val relay = relaySnapshot()
        if (relay == null) {
            promise.reject(
                "DEVICE_LINK_RELAY_PROBE_FAILED",
                "DeviceLink Relay is not configured",
            )
            return
        }
        val timeout = timeoutMillis.toLong().coerceAtLeast(1)
        runAsync(
            promise,
            "DEVICE_LINK_RELAY_PROBE_FAILED",
            "Relay peer handshake failed",
        ) {
            val response =
                requestAgentHTTPWithStream(
                    Mobile.dialRelay(
                        relay.endpoint,
                        relay.queryJSON,
                        relay.headersJSON,
                        relay.subprotocol,
                        timeout,
                    ),
                    "GET",
                    "/v1/preferences/desktop",
                    "",
                    timeout,
                )
            val protocolEpoch = response.getInt("protocolEpoch")
            require(protocolEpoch.toLong() == Mobile.protocolEpoch()) {
                "Relay peer uses an unsupported DeviceLink protocol epoch"
            }
            val status = response.getInt("status")
            require(status in 200..299) {
                "Relay peer control request returned HTTP $status"
            }
            null
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
        val relay = relaySnapshot()
        if (selected == null && relay == null) {
            promise.reject(
                "DEVICE_LINK_REQUEST_FAILED",
                "DeviceLink is not prepared",
            )
            return
        }
        runAsync(promise, "DEVICE_LINK_REQUEST_FAILED", "DeviceLink request failed") {
            if (selected != null && relay != null) {
                val stream = selected.openStreamWithRelay(
                    relay.endpoint,
                    relay.queryJSON,
                    relay.headersJSON,
                    relay.subprotocol,
                    timeoutMillis.toLong().coerceAtLeast(1),
                )
                return@runAsync requestAgentHTTPWithStream(
                    stream,
                    method,
                    path,
                    body,
                    timeoutMillis.toLong(),
                )
            }
            if (selected != null) {
                val stream = selected.openStream(timeoutMillis.toLong().coerceAtLeast(1))
                return@runAsync requestAgentHTTPWithStream(
                    stream,
                    method,
                    path,
                    body,
                    timeoutMillis.toLong(),
                )
            }
            if (relay != null) {
                return@runAsync requestAgentHTTPWithStream(
                    Mobile.dialRelay(
                        relay.endpoint,
                        relay.queryJSON,
                        relay.headersJSON,
                        relay.subprotocol,
                        timeoutMillis.toLong(),
                    ),
                    method,
                    path,
                    body,
                    timeoutMillis.toLong(),
                )
            }
            throw IllegalStateException("DeviceLink request is not configured")
        }
    }

    @ReactMethod
    fun startAgentLive(
        workspaceId: String,
        subscriptionGeneration: Double,
        promise: Promise,
    ) {
        val normalizedWorkspaceId = workspaceId.trim()
        if (normalizedWorkspaceId.isEmpty()) {
            promise.reject(
                "AGENT_LIVE_SUBSCRIBE_FAILED",
                "Agent live workspace id is required",
            )
            return
        }
        if (
            !subscriptionGeneration.isFinite() ||
            subscriptionGeneration <= 0 ||
            subscriptionGeneration % 1.0 != 0.0
        ) {
            promise.reject(
                "AGENT_LIVE_SUBSCRIBE_FAILED",
                "Agent live subscription generation must be a positive integer",
            )
            return
        }
        val selected = linkSnapshot()
        val relay = relaySnapshot()
        if (selected == null && relay == null) {
            promise.reject(
                "AGENT_LIVE_SUBSCRIBE_FAILED",
                "DeviceLink is not prepared",
            )
            return
        }
        val generation = beginAgentLiveOperation()
        try {
            agentLiveExecutor.execute {
                var stream: Stream? = null
                var promiseSettled = false
                try {
                    stream = openAgentStream(
                        selected,
                        relay,
                        AGENT_LIVE_OPEN_TIMEOUT_MILLIS,
                    )
                    check(promoteAgentLiveStream(stream, generation)) {
                        "Agent live subscription was cancelled"
                    }
                    val subscriber = Liveprotocolmobile.newSubscriber(0, 0)
                    val requestID = UUID.randomUUID().toString()
                    val subscription =
                        JSONObject()
                            .put(
                                "protocolRevision",
                                Liveprotocolmobile.protocolRevision(),
                            ).put("workspaceId", normalizedWorkspaceId)
                            .toString()
                            .toByteArray(StandardCharsets.UTF_8)
                    val request =
                        JSONObject()
                            .put("protocolEpoch", Mobile.protocolEpoch())
                            .put("service", "agent_live")
                            .put("requestId", requestID)
                            .put("method", "SUBSCRIBE")
                            .put(
                                "path",
                                "/v1/workspaces/$normalizedWorkspaceId/agent-live",
                            ).put(
                                "body",
                                Base64.encodeToString(
                                    subscription,
                                    Base64.NO_WRAP,
                                ),
                            ).toString()
                            .toByteArray(StandardCharsets.UTF_8)
                    require(request.size <= MAX_REQUEST_FRAME_BYTES) {
                        "Agent live subscription request is too large"
                    }
                    writeFully(
                        stream,
                        ByteBuffer
                            .allocate(Int.SIZE_BYTES + request.size)
                            .order(ByteOrder.BIG_ENDIAN)
                            .putInt(request.size)
                            .put(request)
                            .array(),
                    )
                    promise.resolve(null)
                    promiseSettled = true
                    while (isAgentLiveCurrent(stream, generation)) {
                        val header = readFully(stream, Int.SIZE_BYTES)
                        val frameSize =
                            ByteBuffer.wrap(header).order(ByteOrder.BIG_ENDIAN).int
                        require(frameSize in 1..MAX_AGENT_LIVE_FRAME_BYTES) {
                            "Agent live frame size is invalid"
                        }
                        val result =
                            JSONObject(
                                subscriber.apply(readFully(stream, frameSize)),
                            )
                        logAgentLiveControl(result)
                        if (isAgentLiveCurrent(stream, generation)) {
                            emitAgentLive(
                                JSONObject()
                                    .put("workspaceId", normalizedWorkspaceId)
                                    .put(
                                        "subscriptionGeneration",
                                        subscriptionGeneration,
                                    )
                                    .put("result", result)
                                    .toString(),
                            )
                        }
                    }
                } catch (error: Throwable) {
                    if (!promiseSettled) {
                        promise.reject(
                            "AGENT_LIVE_SUBSCRIBE_FAILED",
                            "Unable to start Agent live subscription",
                            error,
                        )
                    } else if (isAgentLiveGenerationCurrent(generation)) {
                        Log.i(DEVICE_LINK_LOG_TAG, "Agent live stream disconnected")
                        emitAgentLive(
                            JSONObject()
                                .put("workspaceId", normalizedWorkspaceId)
                                .put(
                                    "subscriptionGeneration",
                                    subscriptionGeneration,
                                )
                                .put("status", "disconnected")
                                .put("reason", "stream_closed")
                                .toString(),
                        )
                    }
                } finally {
                    clearAgentLiveStream(stream, generation)
                    runCatching { stream?.close() }
                }
            }
        } catch (error: RejectedExecutionException) {
            promise.reject(
                "AGENT_LIVE_SUBSCRIBE_FAILED",
                "DeviceLink is busy; try again",
                error,
            )
        }
    }

    @ReactMethod
    fun stopAgentLive(promise: Promise) {
        closeCurrentAgentLiveStream()
        promise.resolve(null)
    }

    @ReactMethod
    fun addListener(eventName: String) = Unit

    @ReactMethod
    fun removeListeners(count: Double) = Unit

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

    override fun onStop(owner: LifecycleOwner) {
        closeCurrentAgentLiveStream()
    }

    override fun onHostDestroy() {
        handler.removeCallbacks(backgroundClose)
        closeCurrentLink()
    }

    override fun invalidate() {
        invalidated = true
        handler.removeCallbacks(backgroundClose)
        reactApplicationContext.removeLifecycleEventListener(this)
        UiThreadUtil.runOnUiThread {
            processLifecycle.removeObserver(this)
        }
        closeCurrentLink()
        agentLiveExecutor.shutdownNow()
        candidateExecutor.shutdownNow()
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
        closeCurrentAgentLiveStream()
        val previous =
            synchronized(this) {
                linkGeneration += 1
                val detached = link
                link = null
                relayConfig = null
                detached
            }
        closeDetachedLink(previous)
    }

    @Synchronized
    private fun cancelLinkOperation(generation: Long): Link? {
        if (generation != linkGeneration) {
            return null
        }
        linkGeneration += 1
        val detached = link
        link = null
        return detached
    }

    @Synchronized
    private fun relaySnapshot(): RelayConfig? = relayConfig

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

    private fun beginAgentLiveOperation(): Long {
        var generation: Long
        val previous =
            synchronized(this) {
                agentLiveGeneration += 1
                generation = agentLiveGeneration
                val detached = agentLiveStream
                agentLiveStream = null
                detached
            }
        closeDetachedAgentLiveStream(previous)
        return generation
    }

    @Synchronized
    private fun promoteAgentLiveStream(
        next: Stream,
        generation: Long,
    ): Boolean {
        if (generation != agentLiveGeneration) {
            return false
        }
        agentLiveStream = next
        return true
    }

    @Synchronized
    private fun isAgentLiveCurrent(
        stream: Stream,
        generation: Long,
    ): Boolean =
        generation == agentLiveGeneration && agentLiveStream === stream

    @Synchronized
    private fun isAgentLiveGenerationCurrent(generation: Long): Boolean =
        generation == agentLiveGeneration

    @Synchronized
    private fun clearAgentLiveStream(
        stream: Stream?,
        generation: Long,
    ) {
        if (generation == agentLiveGeneration && agentLiveStream === stream) {
            agentLiveStream = null
        }
    }

    private fun closeCurrentAgentLiveStream() {
        val previous =
            synchronized(this) {
                agentLiveGeneration += 1
                val detached = agentLiveStream
                agentLiveStream = null
                detached
            }
        closeDetachedAgentLiveStream(previous)
    }

    private fun closeDetachedAgentLiveStream(detached: Stream?) {
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

    private fun emitAgentLive(payload: String) {
        if (!reactApplicationContext.hasActiveReactInstance()) {
            return
        }
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(AGENT_LIVE_EVENT_NAME, payload)
    }

    private fun logAgentLiveControl(result: JSONObject) {
        val accepted = result.optJSONArray("accepted") ?: return
        for (index in 0 until accepted.length()) {
            when (accepted.optJSONObject(index)?.optString("kind")) {
                "stream_ready" ->
                    Log.i(DEVICE_LINK_LOG_TAG, "Agent live stream ready")
                "discontinuity" ->
                    Log.i(
                        DEVICE_LINK_LOG_TAG,
                        "Agent live stream requested canonical reconciliation",
                    )
                "rejected" ->
                    Log.w(DEVICE_LINK_LOG_TAG, "Agent live stream rejected")
            }
        }
    }

    private fun writeFully(
        stream: Stream,
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
        stream: Stream,
        size: Int,
    ): ByteArray {
        val output = ByteArrayOutputStream(size)
        while (output.size() < size) {
            val remaining = size - output.size()
            val chunk = ByteArray(minOf(remaining, MAX_READ_CHUNK))
            val count = stream.readInto(chunk).toInt()
            require(count > 0 && count <= chunk.size) {
                "DeviceLink stream closed before the response completed"
            }
            output.write(chunk, 0, count)
        }
        return output.toByteArray()
    }

    private fun requestAgentHTTPWithStream(
        stream: Stream,
        method: String,
        path: String,
        body: String,
        timeoutMillis: Long,
    ): ReadableMap {
        val timeout = timeoutMillis.coerceAtLeast(1)
        val deadline = SystemClock.elapsedRealtime() + timeout
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
                        Base64.encodeToString(bodyBytes, Base64.NO_WRAP),
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
                    String(readFully(stream, responseSize), StandardCharsets.UTF_8),
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
            return Arguments.createMap().apply {
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

    private fun openAgentStream(
        selected: Link?,
        relay: RelayConfig?,
        timeoutMillis: Long,
    ): Stream {
        if (selected != null && relay != null) {
            return selected.openStreamWithRelay(
                relay.endpoint,
                relay.queryJSON,
                relay.headersJSON,
                relay.subprotocol,
                timeoutMillis,
            )
        }
        var directFailure: Throwable? = null
        if (selected != null) {
            try {
                return selected.openStream(timeoutMillis)
            } catch (error: Throwable) {
                directFailure = error
            }
        }
        if (relay != null) {
            try {
                return Mobile.dialRelay(
                    relay.endpoint,
                    relay.queryJSON,
                    relay.headersJSON,
                    relay.subprotocol,
                    timeoutMillis,
                )
            } catch (error: Throwable) {
                if (directFailure != null) {
                    throw IllegalStateException("direct and Relay Agent live streams failed", error)
                }
                throw error
            }
        }
        throw directFailure ?: IllegalStateException("DeviceLink Agent live stream is unavailable")
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

    private fun runCandidateAsync(
        promise: Promise,
        code: String,
        message: String,
        operation: () -> Any?,
    ) {
        try {
            candidateExecutor.execute {
                runCatching(operation).fold(promise::resolve) {
                    promise.reject(code, message, it)
                }
            }
        } catch (error: RejectedExecutionException) {
            promise.reject(code, "DeviceLink candidate exchange is busy; try again", error)
        }
    }

    companion object {
        private const val AGENT_LIVE_EVENT_NAME = "TuttiDeviceLinkAgentLive"
        private const val AGENT_LIVE_OPEN_TIMEOUT_MILLIS = 10_000L
        private const val BACKGROUND_GRACE_MILLIS = 15_000L
        private const val DEVICE_LINK_LOG_TAG = "TuttiDeviceLink"
        private const val MAX_AGENT_LIVE_FRAME_BYTES = 2 shl 20
        private const val MAX_READ_CHUNK = 1 shl 20
        private const val MAX_REQUEST_BODY_BYTES = 8 shl 20
        private const val MAX_RESPONSE_BODY_BYTES = 16 shl 20
        private const val FRAME_ENVELOPE_BYTES = 1 shl 20
        private const val MAX_REQUEST_FRAME_BYTES =
            ((MAX_REQUEST_BODY_BYTES + 2) / 3 * 4) + FRAME_ENVELOPE_BYTES
        private const val MAX_RESPONSE_FRAME_BYTES =
            ((MAX_RESPONSE_BODY_BYTES + 2) / 3 * 4) + FRAME_ENVELOPE_BYTES
    }

    private data class RelayConfig(
        val endpoint: String,
        val queryJSON: String,
        val headersJSON: String,
        val subprotocol: String,
    )
}
