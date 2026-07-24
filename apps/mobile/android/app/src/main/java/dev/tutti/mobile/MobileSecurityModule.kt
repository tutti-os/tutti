package dev.tutti.mobile

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.network.ForwardingCookieHandler
import com.google.zxing.client.android.Intents
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.nio.charset.StandardCharsets
import java.net.URI
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Locale
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

class MobileSecurityModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    private val browserAuthBridge = MobileBrowserAuthBridge(reactContext)
    private val store = SecureStore(reactContext)
    private var scanPromise: Promise? = null
    private val scanContract = ScanContract()
    private val activityEventListener =
        object : BaseActivityEventListener() {
            override fun onActivityResult(
                activity: Activity,
                requestCode: Int,
                resultCode: Int,
                intent: Intent?,
            ) {
                if (requestCode != QR_SCAN_REQUEST_CODE) {
                    return
                }
                val result = scanContract.parseResult(resultCode, intent)
                val promise = scanPromise ?: return
                scanPromise = null
                val value = result.contents?.trim().orEmpty()
                when {
                    result.originalIntent?.getBooleanExtra(
                        Intents.Scan.MISSING_CAMERA_PERMISSION,
                        false,
                    ) == true ->
                        promise.reject(
                            "SCANNER_PERMISSION_DENIED",
                            "Camera permission is required",
                        )
                    result.contents == null ->
                        promise.reject(
                            "SCAN_CANCELLED",
                            "QR scan cancelled",
                        )
                    value.isEmpty() ->
                        promise.reject(
                            "EMPTY_QR_CODE",
                            "The scanned QR code is empty",
                        )
                    else -> promise.resolve(value)
                }
            }
        }

    init {
        reactContext.addActivityEventListener(activityEventListener)
    }

    override fun getName(): String = "TuttiMobileSecurity"

    override fun getConstants(): Map<String, Any> =
        mapOf(
            "clientVersion" to BuildConfig.VERSION_NAME,
            "localeIdentifier" to Locale.getDefault().toLanguageTag(),
        )

    @ReactMethod
    fun getOrCreateIdentity(promise: Promise) {
        runCatching {
            val identity = store.getOrCreateIdentity()
            Arguments.createMap().apply {
                putString("deviceId", identity.deviceId)
                putString("publicKey", identity.publicKey)
                putString("arch", Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown")
                putString("deviceName", Build.MODEL.ifBlank { "Android" })
            }
        }.fold(promise::resolve) {
            Log.e("TuttiMobileSecurity", "Unable to load device identity", it)
            promise.reject("IDENTITY_UNAVAILABLE", "Unable to load device identity", it)
        }
    }

    @ReactMethod
    fun sign(message: String, promise: Promise) {
        runCatching {
            store.sign(message.toByteArray(StandardCharsets.UTF_8))
        }.fold(promise::resolve) {
            Log.e("TuttiMobileSecurity", "Unable to sign device proof", it)
            promise.reject("SIGN_FAILED", "Unable to sign device proof", it)
        }
    }

    @ReactMethod
    fun loadSession(promise: Promise) {
        runCatching {
            store.loadSession()?.let { session ->
                Arguments.createMap().apply {
                    putString("sessionId", session.getString("sessionId"))
                    putString("userId", session.optString("userId"))
                    putString("email", session.optString("email"))
                    putString("name", session.optString("name"))
                }
            }
        }.fold(promise::resolve) {
            promise.reject("SESSION_READ_FAILED", "Unable to read account session", it)
        }
    }

    @ReactMethod
    fun saveSession(
        sessionId: String,
        userId: String,
        email: String,
        name: String,
        promise: Promise,
    ) {
        runCatching {
            store.saveSession(
                JSONObject()
                    .put("sessionId", sessionId.trim())
                    .put("userId", userId.trim())
                    .put("email", email.trim())
                    .put("name", name.trim()),
            )
        }.fold({ promise.resolve(null) }) {
            promise.reject("SESSION_WRITE_FAILED", "Unable to save account session", it)
        }
    }

    @ReactMethod
    fun clearSession(promise: Promise) {
        runCatching(store::clearSession).fold({ promise.resolve(null) }) {
            promise.reject("SESSION_CLEAR_FAILED", "Unable to clear account session", it)
        }
    }

    @ReactMethod
    fun installSessionCookie(
        accountBaseURL: String,
        sessionId: String,
        promise: Promise,
    ) {
        runCatching {
            val cookieURL = validatedCookieURL(accountBaseURL)
            val normalizedSessionID = sessionId.trim()
            require(
                normalizedSessionID.isNotEmpty() &&
                    normalizedSessionID.none {
                        it == ';' || it == '\r' || it == '\n'
                    },
            ) {
                "Account session is invalid"
            }
            ForwardingCookieHandler().addCookies(
                cookieURL,
                listOf(
                    "session_id=$normalizedSessionID; Path=/; Secure; HttpOnly; SameSite=Lax",
                ),
            )
        }.fold({ promise.resolve(null) }) {
            promise.reject(
                "SESSION_COOKIE_WRITE_FAILED",
                "Unable to install account session cookie",
                it,
            )
        }
    }

    @ReactMethod
    fun clearSessionCookie(
        accountBaseURL: String,
        promise: Promise,
    ) {
        runCatching {
            ForwardingCookieHandler().addCookies(
                validatedCookieURL(accountBaseURL),
                listOf(
                    "session_id=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
                ),
            )
        }.fold({ promise.resolve(null) }) {
            promise.reject(
                "SESSION_COOKIE_CLEAR_FAILED",
                "Unable to clear account session cookie",
                it,
            )
        }
    }

    @ReactMethod
    fun startBrowserLogin(
        appId: String,
        authLoginURL: String,
        appCallbackURL: String,
        promise: Promise,
    ) {
        runCatching {
            val identity = store.getOrCreateIdentity()
            browserAuthBridge.startLogin(
                appId = appId,
                authLoginURL = authLoginURL,
                appCallbackURL = appCallbackURL,
                deviceId = identity.deviceId,
                deviceName = Build.MODEL.ifBlank { "Android" },
                clientVersion = BuildConfig.VERSION_NAME,
                promise = promise,
            )
        }.onFailure {
            promise.reject(
                "BROWSER_LOGIN_FAILED",
                "Unable to start browser login",
                it,
            )
        }
    }

    @ReactMethod
    fun scanQRCode(promise: Promise) {
        val activity = reactContext.currentActivity
        if (activity == null) {
            promise.reject("SCANNER_UNAVAILABLE", "No active Android activity")
            return
        }
        if (scanPromise != null) {
            promise.reject("SCANNER_BUSY", "A QR scan is already active")
            return
        }
        scanPromise = promise
        activity.runOnUiThread {
            try {
                val options =
                    ScanOptions()
                    .setDesiredBarcodeFormats(
                        listOf(ScanOptions.QR_CODE),
                    ).setPrompt(
                        reactContext.getString(R.string.scan_pairing_qr),
                    ).setBeepEnabled(false)
                    .setOrientationLocked(false)
                activity.startActivityForResult(
                    scanContract.createIntent(activity, options),
                    QR_SCAN_REQUEST_CODE,
                )
            } catch (cause: Exception) {
                if (scanPromise === promise) {
                    scanPromise = null
                    promise.reject(
                        "SCAN_FAILED",
                        "Unable to scan QR code",
                        cause,
                    )
                }
            }
        }
    }

    override fun invalidate() {
        reactContext.removeActivityEventListener(activityEventListener)
        browserAuthBridge.close()
        scanPromise?.reject(
            "SCANNER_UNAVAILABLE",
            "QR scanner was closed",
        )
        scanPromise = null
        super.invalidate()
    }

    companion object {
        private const val QR_SCAN_REQUEST_CODE = 51731

        private fun validatedCookieURL(rawURL: String): String {
            val uri = URI(rawURL.trim())
            require(
                uri.scheme == "https" &&
                    !uri.rawAuthority.isNullOrBlank(),
            ) {
                "Account URL must use HTTPS"
            }
            return "${uri.scheme}://${uri.rawAuthority}/"
        }
    }
}

private data class PublicIdentity(
    val deviceId: String,
    val publicKey: String,
)

private class SecureStore(
    context: ReactApplicationContext,
) {
    private val preferences =
        context.getSharedPreferences("tutti_mobile_secure_state", 0)
    private val keyStore =
        KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }

    @Synchronized
    fun getOrCreateIdentity(): PublicIdentity {
        val deviceId =
            preferences.getString(DEVICE_ID, null)?.takeIf(String::isNotBlank)
                ?: UUID.randomUUID().toString().also {
                    preferences.edit().putString(DEVICE_ID, it).apply()
                }
        val keyPair = loadOrCreateSigningKey()
        return PublicIdentity(
            deviceId = deviceId,
            publicKey = encodeBase64Url(rawEd25519PublicKey(keyPair.public.encoded)),
        )
    }

    @Synchronized
    fun sign(message: ByteArray): String {
        val keyPair = loadOrCreateSigningKey()
        val signature =
            Signature.getInstance(ED25519, KEYSTORE_OPERATION_PROVIDER).run {
                initSign(keyPair.private)
                update(message)
                sign()
            }
        return Base64.encodeToString(signature, Base64.NO_WRAP)
    }

    @Synchronized
    fun loadSession(): JSONObject? {
        val encrypted = preferences.getString(AUTH_SESSION, null) ?: return null
        return try {
            JSONObject(String(decrypt(encrypted), StandardCharsets.UTF_8))
        } catch (_: Exception) {
            preferences.edit().remove(AUTH_SESSION).apply()
            null
        }
    }

    @Synchronized
    fun saveSession(session: JSONObject) {
        require(session.getString("sessionId").isNotBlank()) {
            "session id is required"
        }
        preferences
            .edit()
            .putString(
                AUTH_SESSION,
                encrypt(session.toString().toByteArray(StandardCharsets.UTF_8)),
            ).apply()
    }

    @Synchronized
    fun clearSession() {
        preferences.edit().remove(AUTH_SESSION).apply()
    }

    private fun loadOrCreateSigningKey(): KeyPair {
        runCatching {
            val privateKey =
                keyStore.getKey(SIGNING_KEY_ALIAS, null) as? PrivateKey
            val publicKey =
                keyStore.getCertificate(SIGNING_KEY_ALIAS)?.publicKey
            if (privateKey != null && publicKey != null) {
                val keyPair = KeyPair(publicKey, privateKey)
                rawEd25519PublicKey(keyPair.public.encoded)
                return keyPair
            }
        }.onFailure {
            keyStore.deleteEntry(SIGNING_KEY_ALIAS)
        }
        return createSigningKey()
    }

    private fun createSigningKey(): KeyPair {
        return KeyPairGenerator
            .getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEY_STORE)
            .apply {
                initialize(
                    KeyGenParameterSpec
                        .Builder(
                            SIGNING_KEY_ALIAS,
                            KeyProperties.PURPOSE_SIGN or
                                KeyProperties.PURPOSE_VERIFY,
                        ).setAlgorithmParameterSpec(
                            ECGenParameterSpec(ED25519),
                        )
                        .setDigests(KeyProperties.DIGEST_NONE)
                        .build(),
                )
            }.generateKeyPair()
            .also { rawEd25519PublicKey(it.public.encoded) }
    }

    private fun encryptionKey(): SecretKey {
        val existing = keyStore.getKey(ENCRYPTION_KEY_ALIAS, null)
        if (existing is SecretKey) {
            return existing
        }
        return KeyGenerator
            .getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE)
            .apply {
                init(
                    KeyGenParameterSpec
                        .Builder(
                            ENCRYPTION_KEY_ALIAS,
                            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setRandomizedEncryptionRequired(true)
                        .build(),
                )
            }.generateKey()
    }

    private fun encrypt(plainText: ByteArray): String {
        val cipher =
            Cipher.getInstance(AES_GCM).apply {
                init(Cipher.ENCRYPT_MODE, encryptionKey())
            }
        val cipherText = cipher.doFinal(plainText)
        return listOf(cipher.iv, cipherText).joinToString(".") {
            Base64.encodeToString(it, Base64.NO_WRAP)
        }
    }

    private fun decrypt(payload: String): ByteArray {
        val parts = payload.split(".", limit = 2)
        require(parts.size == 2) { "invalid encrypted payload" }
        val iv = Base64.decode(parts[0], Base64.NO_WRAP)
        val cipherText = Base64.decode(parts[1], Base64.NO_WRAP)
        return Cipher
            .getInstance(AES_GCM)
            .apply {
                init(
                    Cipher.DECRYPT_MODE,
                    encryptionKey(),
                    GCMParameterSpec(128, iv),
                )
            }.doFinal(cipherText)
    }

    private fun rawEd25519PublicKey(encoded: ByteArray): ByteArray {
        require(
            encoded.size ==
                ED25519_SUBJECT_PUBLIC_KEY_INFO_PREFIX.size +
                ED25519_PUBLIC_KEY_BYTES &&
                encoded
                    .copyOfRange(
                        0,
                        ED25519_SUBJECT_PUBLIC_KEY_INFO_PREFIX.size,
                    ).contentEquals(ED25519_SUBJECT_PUBLIC_KEY_INFO_PREFIX),
        ) {
            "invalid Ed25519 public key"
        }
        return encoded.copyOfRange(
            ED25519_SUBJECT_PUBLIC_KEY_INFO_PREFIX.size,
            encoded.size,
        )
    }

    private fun encodeBase64Url(bytes: ByteArray): String =
        Base64.encodeToString(
            bytes,
            Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
        )

    companion object {
        private const val AES_GCM = "AES/GCM/NoPadding"
        private const val ANDROID_KEY_STORE = "AndroidKeyStore"
        private const val AUTH_SESSION = "account_session"
        private const val DEVICE_ID = "device_id"
        private const val ED25519 = "Ed25519"
        private const val ED25519_PUBLIC_KEY_BYTES = 32
        private const val ENCRYPTION_KEY_ALIAS = "tutti-mobile-storage-v1"
        private const val KEYSTORE_OPERATION_PROVIDER =
            "AndroidKeyStoreBCWorkaround"
        private const val SIGNING_KEY_ALIAS =
            "tutti-mobile-signing-ed25519-v1"
        private val ED25519_SUBJECT_PUBLIC_KEY_INFO_PREFIX =
            byteArrayOf(
                0x30,
                0x2a,
                0x30,
                0x05,
                0x06,
                0x03,
                0x2b,
                0x65,
                0x70,
                0x03,
                0x21,
                0x00,
            )
    }
}
