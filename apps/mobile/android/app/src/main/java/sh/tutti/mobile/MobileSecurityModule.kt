package sh.tutti.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.modules.network.ForwardingCookieHandler
import com.google.zxing.client.android.Intents
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.net.URI
import java.nio.charset.StandardCharsets
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors
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
    private val updateExecutor = Executors.newSingleThreadExecutor()
    private val updateDownloader = MobileUpdateDownloader(reactContext.cacheDir)
    private var scanPromise: Promise? = null
    private var scanCancellationPromise: Promise? = null
    private var scanActivity: Activity? = null
    private var scanRequestCode: Int? = null
    private var nextScanRequestCode = QR_SCAN_REQUEST_CODE_MIN
    private val scanContract = ScanContract()
    private val activityEventListener =
        object : BaseActivityEventListener() {
            override fun onActivityResult(
                activity: Activity,
                requestCode: Int,
                resultCode: Int,
                intent: Intent?,
            ) {
                if (requestCode != scanRequestCode) {
                    return
                }
                val promise = scanPromise
                val cancellation = scanCancellationPromise
                if (promise == null && cancellation == null) {
                    return
                }
                scanPromise = null
                scanCancellationPromise = null
                scanActivity = null
                scanRequestCode = null
                if (cancellation != null) {
                    promise?.reject("SCAN_CANCELLED", "QR scan cancelled")
                    cancellation.resolve(null)
                    return
                }
                val result = scanContract.parseResult(resultCode, intent)
                if (promise == null) {
                    return
                }
                if (
                    result.originalIntent?.getBooleanExtra(
                        PairingCaptureActivity.EXTRA_MANUAL_PAIRING,
                        false,
                    ) == true
                ) {
                    promise.resolve(
                        Arguments.createMap().apply {
                            putString("kind", "manual")
                        },
                    )
                    return
                }
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
                    else ->
                        promise.resolve(
                            Arguments.createMap().apply {
                                putString("kind", "scanned")
                                putString("value", value)
                            },
                        )
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
            "clientVersionCode" to BuildConfig.VERSION_CODE,
            "localeIdentifier" to Locale.getDefault().toLanguageTag(),
        )

    @ReactMethod
    fun installUpdate(
        apkURL: String,
        expectedSHA256: String,
        promise: Promise,
    ) {
        UiThreadUtil.runOnUiThread {
            val activity = reactContext.currentActivity
            if (activity == null) {
                val cause = IllegalStateException("No active Android activity")
                Log.e(LOG_TAG, "Unable to start update: no active activity", cause)
                promise.reject(
                    "UPDATE_INSTALL_FAILED",
                    "No active Android activity",
                    cause,
                )
                return@runOnUiThread
            }
            if (
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                !reactContext.packageManager.canRequestPackageInstalls()
            ) {
                try {
                    Log.i(LOG_TAG, "Update install permission is missing; opening settings")
                    activity.startActivity(
                        Intent(
                            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:${reactContext.packageName}"),
                        ),
                    )
                } catch (cause: Throwable) {
                    Log.e(LOG_TAG, "Unable to open Android install permission settings", cause)
                    promise.reject(
                        "UPDATE_PERMISSION_SETTINGS_FAILED",
                        "Unable to open Android install permission settings",
                        cause,
                    )
                    return@runOnUiThread
                }
                Log.i(LOG_TAG, "Android install permission settings opened")
                promise.reject(
                    "UPDATE_INSTALL_PERMISSION_REQUIRED",
                    "Allow Tutti to install unknown apps, then try again",
                )
                return@runOnUiThread
            }
            Log.i(LOG_TAG, "Android install permission is available; starting update download")

            try {
                updateExecutor.execute {
                    try {
                        val apkFile = updateDownloader.download(apkURL, expectedSHA256)
                        Log.i(
                            LOG_TAG,
                            "Update APK download completed: path=${apkFile.absolutePath}, " +
                                "exists=${apkFile.exists()}, canRead=${apkFile.canRead()}, " +
                                "bytes=${apkFile.length()}",
                        )
                        UiThreadUtil.runOnUiThread {
                            val installerActivity = reactContext.currentActivity
                            if (installerActivity == null) {
                                val cause =
                                    IllegalStateException("No active Android activity")
                                Log.e(
                                    LOG_TAG,
                                    "Unable to launch package installer: no active activity",
                                    cause,
                                )
                                promise.reject(
                                    "UPDATE_INSTALL_FAILED",
                                    "No active Android activity",
                                    cause,
                                )
                                return@runOnUiThread
                            }
                            val uri = try {
                                FileProvider.getUriForFile(
                                    reactContext,
                                    "${BuildConfig.APPLICATION_ID}.fileprovider",
                                    apkFile,
                                )
                            } catch (cause: Throwable) {
                                Log.e(
                                    LOG_TAG,
                                    "Unable to create update FileProvider URI for " +
                                        apkFile.absolutePath,
                                    cause,
                                )
                                promise.reject(
                                    "UPDATE_URI_FAILED",
                                    "Unable to prepare the Android update file",
                                    cause,
                                )
                                return@runOnUiThread
                            }
                            Log.i(LOG_TAG, "Update FileProvider URI created: $uri")
                            try {
                                installerActivity.startActivity(
                                    Intent(Intent.ACTION_VIEW).apply {
                                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                        setDataAndType(
                                            uri,
                                            "application/vnd.android.package-archive",
                                        )
                                    },
                                )
                                Log.i(LOG_TAG, "Android package installer activity started")
                                promise.resolve(null)
                            } catch (cause: Throwable) {
                                Log.e(LOG_TAG, "Unable to launch Android package installer", cause)
                                promise.reject(
                                    "UPDATE_INSTALLER_LAUNCH_FAILED",
                                    "Unable to open the Android package installer",
                                    cause,
                                )
                            }
                        }
                    } catch (cause: MobileUpdateDownloadFailure) {
                        Log.e(
                            LOG_TAG,
                            "Update download failed: code=${cause.code}, " +
                                "message=${cause.message}",
                            cause,
                        )
                        promise.reject(cause.code, cause.message, cause)
                    } catch (cause: Throwable) {
                        Log.e(LOG_TAG, "Unexpected update download failure", cause)
                        promise.reject(
                            "UPDATE_DOWNLOAD_FAILED",
                            cause.message ?: "Unable to download the Android update",
                            cause,
                        )
                    }
                }
            } catch (cause: Throwable) {
                Log.e(LOG_TAG, "Unable to schedule Android update download", cause)
                promise.reject(
                    "UPDATE_EXECUTOR_FAILED",
                    "Unable to start the Android update download",
                    cause,
                )
            }
        }
    }

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
                    putString("avatarURL", session.optString("avatarURL"))
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
        avatarURL: String,
        promise: Promise,
    ) {
        runCatching {
            store.saveSession(
                JSONObject()
                    .put("sessionId", sessionId.trim())
                    .put("userId", userId.trim())
                    .put("email", email.trim())
                    .put("name", name.trim())
                    .put("avatarURL", avatarURL.trim()),
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
    fun clearLegacySessionCookie(
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
                "Unable to clear legacy account session cookie",
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
        UiThreadUtil.runOnUiThread {
            if (scanPromise != null || scanCancellationPromise != null) {
                promise.reject("SCANNER_BUSY", "A QR scan is already active")
                return@runOnUiThread
            }
            val requestCode = nextScanRequestCode
            nextScanRequestCode =
                if (requestCode >= QR_SCAN_REQUEST_CODE_MAX) {
                    QR_SCAN_REQUEST_CODE_MIN
                } else {
                    requestCode + 1
                }
            scanPromise = promise
            scanActivity = activity
            scanRequestCode = requestCode
            try {
                val options =
                    ScanOptions()
                    .setDesiredBarcodeFormats(
                        listOf(ScanOptions.QR_CODE),
                    ).setCaptureActivity(
                        PairingCaptureActivity::class.java,
                    ).setPrompt(
                        reactContext.getString(R.string.scan_pairing_qr),
                    ).setBeepEnabled(false)
                    .setOrientationLocked(false)
                activity.startActivityForResult(
                    scanContract.createIntent(activity, options),
                    requestCode,
                )
            } catch (cause: Exception) {
                if (scanPromise === promise) {
                    scanPromise = null
                    scanActivity = null
                    scanRequestCode = null
                    promise.reject(
                        "SCAN_FAILED",
                        "Unable to scan QR code",
                        cause,
                    )
                }
            }
        }
    }

    @ReactMethod
    fun cancelQRCodeScan(promise: Promise) {
        UiThreadUtil.runOnUiThread {
            val pending = scanPromise
            when {
                pending == null -> promise.resolve(null)
                scanCancellationPromise != null ->
                    promise.reject(
                        "SCANNER_BUSY",
                        "QR scanner cancellation is already in progress",
                    )
                else -> {
                    val activity = scanActivity
                    val requestCode = scanRequestCode
                    if (
                        activity == null ||
                        requestCode == null ||
                        activity.isFinishing ||
                        (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 &&
                            activity.isDestroyed)
                    ) {
                        scanPromise = null
                        scanActivity = null
                        scanRequestCode = null
                        pending.reject("SCAN_CANCELLED", "QR scan cancelled")
                        promise.resolve(null)
                    } else {
                        scanCancellationPromise = promise
                        activity.finishActivity(requestCode)
                    }
                }
            }
        }
    }

    override fun invalidate() {
        updateExecutor.shutdownNow()
        reactContext.removeActivityEventListener(activityEventListener)
        browserAuthBridge.close()
        UiThreadUtil.runOnUiThread {
            val activity = scanActivity
            val requestCode = scanRequestCode
            if (activity != null && requestCode != null) {
                activity.finishActivity(requestCode)
            }
            scanPromise?.reject(
                "SCANNER_UNAVAILABLE",
                "QR scanner was closed",
            )
            scanPromise = null
            scanActivity = null
            scanRequestCode = null
            scanCancellationPromise?.resolve(null)
            scanCancellationPromise = null
        }
        super.invalidate()
    }

    companion object {
        private const val LOG_TAG = "TuttiMobileSecurity"
        private const val QR_SCAN_REQUEST_CODE_MIN = 51731
        private const val QR_SCAN_REQUEST_CODE_MAX = 60000

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

        private fun toHex(bytes: ByteArray): String =
            bytes.joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
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
