package sh.tutti.mobile

import android.util.Log
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Locale

internal class MobileUpdateDownloader(
    private val cacheDir: File,
) {
    fun download(apkURL: String, expectedSHA256: String): File {
        val url = try {
            URL(apkURL.trim())
        } catch (cause: Throwable) {
            throw MobileUpdateDownloadFailure(
                "UPDATE_URL_INVALID",
                "Update URL is invalid",
                cause,
            )
        }
        if (!isHTTPSUpdateURL(url)) {
            throw MobileUpdateDownloadFailure(
                "UPDATE_URL_INVALID",
                "Update URL must use HTTPS",
            )
        }
        val expected = expectedSHA256.trim().lowercase(Locale.ROOT)
        if (!expected.matches(Regex("[a-f0-9]{64}"))) {
            throw MobileUpdateDownloadFailure(
                "UPDATE_CHECKSUM_INVALID",
                "Update SHA-256 is invalid",
            )
        }
        Log.i(
            LOG_TAG,
            "Starting update download: host=${url.host}, path=${url.path}, " +
                "expectedSHA256=$expected",
        )

        val connection = try {
            url.openConnection() as HttpURLConnection
        } catch (cause: Throwable) {
            throw MobileUpdateDownloadFailure(
                "UPDATE_CONNECTION_FAILED",
                "Unable to open update connection",
                cause,
            )
        }
        connection.connectTimeout = UPDATE_CONNECT_TIMEOUT_MS
        connection.readTimeout = UPDATE_READ_TIMEOUT_MS
        connection.requestMethod = "GET"
        connection.setRequestProperty(
            "Accept",
            "application/vnd.android.package-archive",
        )
        try {
            val responseCode = try {
                connection.responseCode
            } catch (cause: Throwable) {
                throw MobileUpdateDownloadFailure(
                    "UPDATE_HTTP_FAILED",
                    "Unable to read update HTTP response",
                    cause,
                )
            }
            Log.i(
                LOG_TAG,
                "Update HTTP response: status=$responseCode, " +
                    "contentLength=${connection.contentLengthLong}",
            )
            if (responseCode !in 200..299) {
                throw MobileUpdateDownloadFailure(
                    "UPDATE_HTTP_FAILED",
                    "Update download failed with HTTP $responseCode",
                )
            }

            val updateDirectory = File(cacheDir, "updates")
            if (!updateDirectory.mkdirs() && !updateDirectory.isDirectory) {
                throw MobileUpdateDownloadFailure(
                    "UPDATE_CACHE_FAILED",
                    "Unable to create update cache directory",
                )
            }
            val temporaryFile = File(updateDirectory, "tutti-update.apk.part")
            val apkFile = File(updateDirectory, "tutti-update.apk")
            Log.i(
                LOG_TAG,
                "Writing update APK to temporary file: ${temporaryFile.absolutePath}",
            )
            val digest = MessageDigest.getInstance("SHA-256")
            var downloadedBytes = 0L
            try {
                BufferedInputStream(connection.inputStream).use { input ->
                    FileOutputStream(temporaryFile).use { output ->
                        val buffer = ByteArray(UPDATE_BUFFER_SIZE)
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            digest.update(buffer, 0, count)
                            output.write(buffer, 0, count)
                            downloadedBytes += count
                        }
                    }
                }
            } catch (cause: Throwable) {
                temporaryFile.delete()
                throw MobileUpdateDownloadFailure(
                    "UPDATE_DOWNLOAD_FAILED",
                    "Unable to write the downloaded Android update",
                    cause,
                )
            }

            val actual = toHex(digest.digest())
            Log.i(
                LOG_TAG,
                "Update download bytes received: $downloadedBytes, actualSHA256=$actual",
            )
            if (actual != expected) {
                temporaryFile.delete()
                throw MobileUpdateDownloadFailure(
                    "UPDATE_CHECKSUM_FAILED",
                    "Downloaded update checksum does not match: " +
                        "expected=$expected actual=$actual",
                )
            }
            if (apkFile.exists() && !apkFile.delete()) {
                throw MobileUpdateDownloadFailure(
                    "UPDATE_CACHE_REPLACE_FAILED",
                    "Unable to replace the cached Android update",
                )
            }
            if (!temporaryFile.renameTo(apkFile)) {
                throw MobileUpdateDownloadFailure(
                    "UPDATE_FILE_FINALIZE_FAILED",
                    "Unable to finalize the downloaded Android update",
                )
            }
            Log.i(
                LOG_TAG,
                "Update APK finalized: ${apkFile.absolutePath}, bytes=${apkFile.length()}",
            )
            return apkFile
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        private const val LOG_TAG = "TuttiMobileSecurity"
        private const val UPDATE_BUFFER_SIZE = 32 * 1024
        private const val UPDATE_CONNECT_TIMEOUT_MS = 15_000
        private const val UPDATE_READ_TIMEOUT_MS = 60_000

        private fun toHex(bytes: ByteArray): String =
            bytes.joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    }
}

internal fun isHTTPSUpdateURL(url: URL): Boolean = url.protocol == "https"

internal class MobileUpdateDownloadFailure(
    val code: String,
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)
