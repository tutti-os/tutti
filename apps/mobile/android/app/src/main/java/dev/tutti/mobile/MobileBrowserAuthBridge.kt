package dev.tutti.mobile

import android.content.Intent
import android.net.Uri
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.Closeable
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors
import org.json.JSONObject

internal class MobileBrowserAuthBridge(
    private val context: ReactApplicationContext,
) : Closeable {
    private val executor = Executors.newSingleThreadExecutor()
    private val lock = Any()
    private var active: LoginAttempt? = null
    private var closed = false
    private var starting = false

    fun startLogin(
        appId: String,
        authLoginURL: String,
        appCallbackURL: String,
        deviceId: String,
        deviceName: String,
        clientVersion: String,
        promise: Promise,
    ) {
        synchronized(lock) {
            if (closed) {
                promise.reject(
                    "BROWSER_LOGIN_UNAVAILABLE",
                    "Browser login is unavailable",
                )
                return
            }
            if (starting || active != null) {
                promise.reject(
                    "BROWSER_LOGIN_BUSY",
                    "A browser login is already active",
                )
                return
            }
            starting = true
        }

        executor.execute {
            var server: ServerSocket? = null
            try {
                server = bindLoopbackServer()
                val attempt =
                    LoginAttempt.create(
                        server = server,
                        appId = appId,
                        authLoginURL = authLoginURL,
                        appCallbackURL = appCallbackURL,
                        deviceId = deviceId,
                        deviceName = deviceName,
                        clientVersion = clientVersion,
                        promise = promise,
                    )
                synchronized(lock) {
                    check(!closed) { "Browser login is unavailable" }
                    starting = false
                    active = attempt
                }
                openBrowser(attempt.loginURL)
                serve(attempt)
            } catch (cause: Exception) {
                val attempt =
                    synchronized(lock) {
                        starting = false
                        active?.takeIf { it.server === server }
                    }
                if (attempt != null) {
                    finish(
                        attempt,
                        Result.failure(
                            BrowserLoginException(
                                "BROWSER_LOGIN_FAILED",
                                "Unable to complete browser login",
                                cause,
                            ),
                        ),
                    )
                } else {
                    server?.closeQuietly()
                    promise.reject(
                        "BROWSER_LOGIN_FAILED",
                        "Unable to start browser login",
                        cause,
                    )
                }
            }
        }
    }

    private fun serve(attempt: LoginAttempt) {
        attempt.server.soTimeout = ACCEPT_TIMEOUT_MILLIS
        while (System.currentTimeMillis() < attempt.expiresAt) {
            if (!isActive(attempt)) {
                return
            }
            try {
                attempt.server.accept().use { socket ->
                    when (val outcome = handleRequest(attempt, socket)) {
                        RequestOutcome.Pending -> Unit
                        is RequestOutcome.Completed -> {
                            finish(attempt, Result.success(outcome.transferCode))
                            return
                        }
                        is RequestOutcome.Failed -> {
                            finish(
                                attempt,
                                Result.failure(
                                    BrowserLoginException(
                                        outcome.code,
                                        outcome.message,
                                    ),
                                ),
                            )
                            return
                        }
                    }
                }
            } catch (_: SocketTimeoutException) {
                // Re-check expiry and module lifecycle.
            }
        }
        finish(
            attempt,
            Result.failure(
                BrowserLoginException(
                    "BROWSER_LOGIN_TIMEOUT",
                    "Browser login timed out",
                ),
            ),
        )
    }

    private fun handleRequest(
        attempt: LoginAttempt,
        socket: Socket,
    ): RequestOutcome {
        socket.soTimeout = REQUEST_TIMEOUT_MILLIS
        val reader =
            BufferedReader(
                InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8),
            )
        val requestLine = reader.readLine().orEmpty()
        val requestParts = requestLine.split(" ", limit = 3)
        if (requestParts.size < 2) {
            sendJSON(socket, 400, """{"ok":false}""")
            return RequestOutcome.Pending
        }
        val headers = readHeaders(reader)
        if (!allowedHost(headers["host"], attempt.port)) {
            sendEmpty(socket, 403)
            return RequestOutcome.Pending
        }

        val method = requestParts[0].uppercase(Locale.US)
        val target = requestParts[1]
        val uri = runCatching { URI(target) }.getOrNull()
        if (uri == null) {
            sendJSON(socket, 400, """{"ok":false}""")
            return RequestOutcome.Pending
        }
        val query = parseQuery(uri.rawQuery)

        if (method == "OPTIONS") {
            if (!allowedOrigin(headers["origin"], attempt.authOrigin)) {
                sendEmpty(socket, 403)
            } else {
                sendEmpty(socket, 204, cors = true)
            }
            return RequestOutcome.Pending
        }

        if (method == "GET" && uri.path == "/oauth/health") {
            val matched =
                query["attempt_id"] == attempt.attemptId &&
                    query["token"] == attempt.bridgeToken &&
                    isActive(attempt) &&
                    System.currentTimeMillis() < attempt.expiresAt
            if (!matched) {
                sendJSON(
                    socket,
                    401,
                    """{"ok":false,"error":{"code":"INVALID_BRIDGE_ATTEMPT"}}""",
                )
                return RequestOutcome.Pending
            }
            sendJSON(
                socket,
                200,
                JSONObject()
                    .put("ok", true)
                    .put(
                        "data",
                        JSONObject()
                            .put("attemptId", attempt.attemptId)
                            .put("status", "ready")
                            .put("expiresAt", attempt.expiresAt),
                    ).toString(),
            )
            return RequestOutcome.Pending
        }

        if (method == "GET" && uri.path == "/oauth/callback") {
            if (query["state"] != attempt.state) {
                sendRedirect(
                    socket,
                    bridgeResultURL(attempt, "error", "invalidState"),
                )
                return RequestOutcome.Failed(
                    "BROWSER_LOGIN_INVALID_STATE",
                    "Browser login state is invalid",
                )
            }
            val callbackError = query["error"].orEmpty().trim()
            if (callbackError.isNotEmpty()) {
                val cancelled = callbackError == "user_cancelled"
                sendRedirect(
                    socket,
                    bridgeResultURL(
                        attempt,
                        "error",
                        if (cancelled) "userCancelled" else "providerError",
                    ),
                )
                return RequestOutcome.Failed(
                    if (cancelled) {
                        "BROWSER_LOGIN_CANCELLED"
                    } else {
                        "BROWSER_LOGIN_FAILED"
                    },
                    if (cancelled) {
                        "Browser login was cancelled"
                    } else {
                        "Browser login provider returned an error"
                    },
                )
            }
            val transferCode = query["transfer_code"].orEmpty().trim()
            if (transferCode.isEmpty()) {
                sendRedirect(
                    socket,
                    bridgeResultURL(attempt, "error", "missingTransferCode"),
                )
                return RequestOutcome.Failed(
                    "BROWSER_LOGIN_FAILED",
                    "Browser login transfer code is missing",
                )
            }
            sendRedirect(socket, bridgeResultURL(attempt, "success"))
            return RequestOutcome.Completed(transferCode)
        }

        sendJSON(socket, 404, """{"ok":false}""")
        return RequestOutcome.Pending
    }

    private fun finish(
        attempt: LoginAttempt,
        result: Result<String>,
    ) {
        val shouldComplete =
            synchronized(lock) {
                if (active !== attempt) {
                    false
                } else {
                    active = null
                    true
                }
            }
        if (!shouldComplete) {
            return
        }
        attempt.server.closeQuietly()
        result.fold(
            onSuccess = { transferCode ->
                attempt.promise.resolve(
                    Arguments.createMap().apply {
                        putString("attemptId", attempt.attemptId)
                        putString("bridgeToken", attempt.bridgeToken)
                        putString("deviceId", attempt.deviceId)
                        putString("transferCode", transferCode)
                    },
                )
            },
            onFailure = { cause ->
                val error =
                    cause as? BrowserLoginException
                        ?: BrowserLoginException(
                            "BROWSER_LOGIN_FAILED",
                            "Unable to complete browser login",
                            cause,
                        )
                attempt.promise.reject(error.code, error.message, error)
            },
        )
    }

    private fun isActive(attempt: LoginAttempt): Boolean =
        synchronized(lock) { active === attempt && !closed }

    private fun openBrowser(url: String) {
        context.startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addCategory(Intent.CATEGORY_BROWSABLE)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            },
        )
    }

    override fun close() {
        val attempt =
            synchronized(lock) {
                if (closed) {
                    return
                }
                closed = true
                starting = false
                active.also { active = null }
            }
        attempt?.server?.closeQuietly()
        attempt?.promise?.reject(
            "BROWSER_LOGIN_UNAVAILABLE",
            "Browser login was closed",
        )
        executor.shutdownNow()
    }

    private data class LoginAttempt(
        val appCallbackURL: String,
        val attemptId: String,
        val authOrigin: String,
        val bridgeToken: String,
        val deviceId: String,
        val expiresAt: Long,
        val loginURL: String,
        val port: Int,
        val promise: Promise,
        val server: ServerSocket,
        val state: String,
    ) {
        companion object {
            fun create(
                server: ServerSocket,
                appId: String,
                authLoginURL: String,
                appCallbackURL: String,
                deviceId: String,
                deviceName: String,
                clientVersion: String,
                promise: Promise,
            ): LoginAttempt {
                val attemptId = UUID.randomUUID().toString()
                val bridgeToken = UUID.randomUUID().toString()
                val origin = "http://$LOOPBACK_HOST:${server.localPort}"
                val authURI = URI(authLoginURL.trim())
                require(
                    authURI.scheme == "https" &&
                        !authURI.rawAuthority.isNullOrBlank(),
                ) {
                    "Browser login URL must use HTTPS"
                }
                val normalizedAppID = appId.trim()
                require(normalizedAppID.isNotEmpty()) { "App id is required" }
                val normalizedAppCallbackURL = appCallbackURL.trim()
                require(
                    normalizedAppCallbackURL == "tutti://auth/login",
                ) {
                    "App callback URL is not allowed"
                }
                val authOrigin = "${authURI.scheme}://${authURI.rawAuthority}"
                val state =
                    JSONObject()
                        .put("v", 1)
                        .put("flow", "desktop_bridge")
                        .put("attemptId", attemptId)
                        .put("localServerOrigin", origin)
                        .put("bridgeToken", bridgeToken)
                        .put("appId", normalizedAppID)
                        .put("appCallbackUrl", normalizedAppCallbackURL)
                        .put("deviceId", deviceId.trim())
                        .put("deviceName", deviceName.trim())
                        .put("clientVersion", clientVersion.trim())
                        .put("hostname", deviceName.trim())
                        .toString()
                        .toByteArray(StandardCharsets.UTF_8)
                        .let {
                            Base64.encodeToString(
                                it,
                                Base64.URL_SAFE or
                                    Base64.NO_WRAP or
                                    Base64.NO_PADDING,
                            )
                        }
                val loginURL =
                    "$authOrigin/auth/login?state=${
                        URLEncoder.encode(state, StandardCharsets.UTF_8.name())
                    }"
                return LoginAttempt(
                    appCallbackURL = normalizedAppCallbackURL,
                    attemptId = attemptId,
                    authOrigin = authOrigin,
                    bridgeToken = bridgeToken,
                    deviceId = deviceId.trim(),
                    expiresAt = System.currentTimeMillis() + LOGIN_TIMEOUT_MILLIS,
                    loginURL = loginURL,
                    port = server.localPort,
                    promise = promise,
                    server = server,
                    state = state,
                )
            }
        }
    }

    private sealed interface RequestOutcome {
        data object Pending : RequestOutcome

        data class Completed(
            val transferCode: String,
        ) : RequestOutcome

        data class Failed(
            val code: String,
            val message: String,
        ) : RequestOutcome
    }

    private class BrowserLoginException(
        val code: String,
        message: String,
        cause: Throwable? = null,
    ) : Exception(message, cause)

    companion object {
        private const val ACCEPT_TIMEOUT_MILLIS = 1_000
        private const val BASE_PORT = 38473
        private const val LOOPBACK_HOST = "127.0.0.1"
        private const val LOGIN_TIMEOUT_MILLIS = 5 * 60_000L
        private const val MAX_PORT = 38492
        private const val REQUEST_TIMEOUT_MILLIS = 5_000

        private fun bindLoopbackServer(): ServerSocket {
            val address = InetAddress.getByName(LOOPBACK_HOST)
            for (port in BASE_PORT..MAX_PORT) {
                try {
                    return ServerSocket(port, 8, address)
                } catch (_: Exception) {
                    // Try the next port reserved for the auth bridge.
                }
            }
            throw IllegalStateException("Unable to allocate browser login port")
        }

        private fun readHeaders(reader: BufferedReader): Map<String, String> {
            val headers = mutableMapOf<String, String>()
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) {
                    break
                }
                val separator = line.indexOf(':')
                if (separator > 0) {
                    headers[line.substring(0, separator).trim().lowercase(Locale.US)] =
                        line.substring(separator + 1).trim()
                }
            }
            return headers
        }

        private fun parseQuery(rawQuery: String?): Map<String, String> {
            if (rawQuery.isNullOrEmpty()) {
                return emptyMap()
            }
            return rawQuery.split("&").associate { field ->
                val parts = field.split("=", limit = 2)
                decode(parts[0]) to decode(parts.getOrElse(1) { "" })
            }
        }

        private fun decode(value: String): String =
            URLDecoder.decode(value, StandardCharsets.UTF_8.name())

        private fun allowedHost(
            hostHeader: String?,
            port: Int,
        ): Boolean {
            val host = hostHeader.orEmpty().trim().lowercase(Locale.US)
            return host == "$LOOPBACK_HOST:$port" || host == "localhost:$port"
        }

        private fun allowedOrigin(
            origin: String?,
            authOrigin: String,
        ): Boolean {
            val value = origin.orEmpty().trim()
            return value.isEmpty() || value == authOrigin
        }

        private fun bridgeResultURL(
            attempt: LoginAttempt,
            status: String,
            safeErrorCode: String? = null,
        ): String {
            val query = mutableListOf("desktopBridgeStatus=${encode(status)}")
            if (!safeErrorCode.isNullOrEmpty()) {
                query += "desktopBridgeError=${encode(safeErrorCode)}"
            }
            if (safeErrorCode != "userCancelled") {
                val openAppParameters =
                    buildList {
                        add("desktopBridgeStatus=${encode(status)}")
                        if (!safeErrorCode.isNullOrEmpty()) {
                            add("desktopBridgeError=${encode(safeErrorCode)}")
                        }
                    }
                val openAppURL =
                    "${attempt.appCallbackURL}?${openAppParameters.joinToString("&")}"
                query += "openAppUrl=${encode(openAppURL)}"
            }
            return "${attempt.authOrigin}/auth/login/callback?${query.joinToString("&")}"
        }

        private fun encode(value: String): String =
            URLEncoder.encode(value, StandardCharsets.UTF_8.name())

        private fun sendEmpty(
            socket: Socket,
            status: Int,
            cors: Boolean = false,
        ) {
            writeResponse(socket, status, emptyMap(), "", cors)
        }

        private fun sendJSON(
            socket: Socket,
            status: Int,
            body: String,
        ) {
            writeResponse(
                socket,
                status,
                mapOf("Content-Type" to "application/json; charset=utf-8"),
                body,
                cors = true,
            )
        }

        private fun sendRedirect(
            socket: Socket,
            location: String,
        ) {
            writeResponse(
                socket,
                302,
                mapOf("Location" to location),
                "",
                cors = false,
            )
        }

        private fun writeResponse(
            socket: Socket,
            status: Int,
            headers: Map<String, String>,
            body: String,
            cors: Boolean,
        ) {
            val bodyBytes = body.toByteArray(StandardCharsets.UTF_8)
            val reason =
                when (status) {
                    200 -> "OK"
                    204 -> "No Content"
                    302 -> "Found"
                    400 -> "Bad Request"
                    401 -> "Unauthorized"
                    403 -> "Forbidden"
                    404 -> "Not Found"
                    else -> "Error"
                }
            val writer =
                BufferedWriter(
                    OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8),
                )
            writer.write("HTTP/1.1 $status $reason\r\n")
            writer.write("Connection: close\r\n")
            writer.write("Content-Length: ${bodyBytes.size}\r\n")
            if (cors) {
                writer.write("Access-Control-Allow-Origin: *\r\n")
                writer.write("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n")
                writer.write("Access-Control-Allow-Headers: Content-Type\r\n")
                writer.write("Access-Control-Allow-Private-Network: true\r\n")
            }
            headers.forEach { (name, value) ->
                writer.write("$name: $value\r\n")
            }
            writer.write("\r\n")
            writer.flush()
            if (bodyBytes.isNotEmpty()) {
                socket.getOutputStream().write(bodyBytes)
                socket.getOutputStream().flush()
            }
        }

        private fun Closeable.closeQuietly() {
            runCatching(::close)
        }
    }
}
