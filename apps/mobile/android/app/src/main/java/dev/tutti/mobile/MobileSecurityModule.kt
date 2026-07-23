package dev.tutti.mobile

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import java.nio.charset.StandardCharsets
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
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
    private val store = SecureStore(reactContext)

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
            promise.reject("IDENTITY_UNAVAILABLE", "Unable to load device identity", it)
        }
    }

    @ReactMethod
    fun sign(message: String, promise: Promise) {
        runCatching {
            store.sign(message.toByteArray(StandardCharsets.UTF_8))
        }.fold(promise::resolve) {
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
    fun scanQRCode(promise: Promise) {
        val activity = reactContext.currentActivity
        if (activity == null) {
            promise.reject("SCANNER_UNAVAILABLE", "No active Android activity")
            return
        }
        val options =
            GmsBarcodeScannerOptions
                .Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .enableAutoZoom()
                .build()
        GmsBarcodeScanning
            .getClient(activity, options)
            .startScan()
            .addOnSuccessListener { barcode ->
                val value = barcode.rawValue?.trim().orEmpty()
                if (value.isEmpty()) {
                    promise.reject("EMPTY_QR_CODE", "The scanned QR code is empty")
                } else {
                    promise.resolve(value)
                }
            }.addOnCanceledListener {
                promise.reject("SCAN_CANCELLED", "QR scan cancelled")
            }.addOnFailureListener {
                promise.reject("SCAN_FAILED", "Unable to scan QR code", it)
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
        val signature =
            Signature.getInstance(ED25519).run {
                initSign(loadOrCreateSigningKey().private)
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
        val encryptedPrivate = preferences.getString(IDENTITY_PRIVATE, null)
        val encodedPublic = preferences.getString(IDENTITY_PUBLIC, null)
        if (encryptedPrivate != null && encodedPublic != null) {
            return try {
                val factory = KeyFactory.getInstance(ED25519)
                KeyPair(
                    factory.generatePublic(
                        X509EncodedKeySpec(Base64.decode(encodedPublic, Base64.NO_WRAP)),
                    ),
                    factory.generatePrivate(PKCS8EncodedKeySpec(decrypt(encryptedPrivate))),
                )
            } catch (_: Exception) {
                preferences
                    .edit()
                    .remove(IDENTITY_PRIVATE)
                    .remove(IDENTITY_PUBLIC)
                    .apply()
                createSigningKey()
            }
        }
        return createSigningKey()
    }

    private fun createSigningKey(): KeyPair {
        val keyPair = KeyPairGenerator.getInstance(ED25519).generateKeyPair()
        preferences
            .edit()
            .putString(
                IDENTITY_PUBLIC,
                Base64.encodeToString(keyPair.public.encoded, Base64.NO_WRAP),
            ).putString(IDENTITY_PRIVATE, encrypt(keyPair.private.encoded))
            .apply()
        return keyPair
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
        require(encoded.size >= ED25519_PUBLIC_KEY_BYTES) {
            "invalid Ed25519 public key"
        }
        return encoded.copyOfRange(
            encoded.size - ED25519_PUBLIC_KEY_BYTES,
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
        private const val IDENTITY_PRIVATE = "device_identity_private"
        private const val IDENTITY_PUBLIC = "device_identity_public"
    }
}
