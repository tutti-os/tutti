package sh.tutti.mobile

import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.net.URL
import java.security.MessageDigest
import java.util.Locale

internal data class MobileUpdateArtifactRequest(
    val expectedSHA256: String,
    val expectedSizeBytes: Long,
    val targetVersionCode: Int,
    val url: URL,
) {
    val fileName: String = mobileUpdateArtifactFileName(expectedSHA256)
}

internal fun mobileUpdateArtifactFileName(expectedSHA256: String): String =
    "tutti-update-$expectedSHA256.apk"

internal fun validateMobileUpdateArtifactRequest(
    apkURL: String,
    expectedSHA256: String,
    expectedSizeBytes: Double,
    targetVersionCode: Double,
): MobileUpdateArtifactRequest {
    val url = try {
        URL(apkURL.trim())
    } catch (cause: Throwable) {
        throw MobileUpdateDownloadFailure(
            "UPDATE_URL_INVALID",
            "Update URL is invalid",
            cause,
        )
    }
    if (url.protocol != "https" || url.host.isBlank() || url.userInfo != null) {
        throw MobileUpdateDownloadFailure(
            "UPDATE_URL_INVALID",
            "Update URL must use credential-free HTTPS",
        )
    }
    val expected = expectedSHA256.trim().lowercase(Locale.ROOT)
    if (!expected.matches(Regex("[a-f0-9]{64}"))) {
        throw MobileUpdateDownloadFailure(
            "UPDATE_CHECKSUM_INVALID",
            "Update SHA-256 is invalid",
        )
    }
    if (
        !expectedSizeBytes.isFinite() ||
        expectedSizeBytes % 1.0 != 0.0 ||
        expectedSizeBytes <= 0.0 ||
        expectedSizeBytes > MAX_MOBILE_UPDATE_BYTES.toDouble()
    ) {
        throw MobileUpdateDownloadFailure(
            "UPDATE_SIZE_INVALID",
            "Update size is invalid or exceeds the supported limit",
        )
    }
    if (
        !targetVersionCode.isFinite() ||
        targetVersionCode % 1.0 != 0.0 ||
        targetVersionCode <= 0.0 ||
        targetVersionCode > Int.MAX_VALUE.toDouble()
    ) {
        throw MobileUpdateDownloadFailure(
            "UPDATE_VERSION_INVALID",
            "Update version code is invalid",
        )
    }
    return MobileUpdateArtifactRequest(
        expectedSHA256 = expected,
        expectedSizeBytes = expectedSizeBytes.toLong(),
        targetVersionCode = targetVersionCode.toInt(),
        url = url,
    )
}

internal fun verifyMobileUpdateArtifact(
    file: File,
    request: MobileUpdateArtifactRequest,
) {
    val actualSize = file.length()
    if (actualSize != request.expectedSizeBytes) {
        throw MobileUpdateDownloadFailure(
            "UPDATE_SIZE_MISMATCH",
            "Downloaded update size does not match: " +
                "expected=${request.expectedSizeBytes} actual=$actualSize",
        )
    }
    val digest = MessageDigest.getInstance("SHA-256")
    try {
        BufferedInputStream(FileInputStream(file)).use { input ->
            val buffer = ByteArray(UPDATE_VERIFY_BUFFER_SIZE)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
    } catch (cause: Throwable) {
        throw MobileUpdateDownloadFailure(
            "UPDATE_CHECKSUM_FAILED",
            "Unable to verify the downloaded Android update",
            cause,
        )
    }
    val actualSHA256 = digest.digest().joinToString("") { byte ->
        "%02x".format(byte.toInt() and 0xff)
    }
    if (actualSHA256 != request.expectedSHA256) {
        throw MobileUpdateDownloadFailure(
            "UPDATE_CHECKSUM_FAILED",
            "Downloaded update checksum does not match: " +
                "expected=${request.expectedSHA256} actual=$actualSHA256",
        )
    }
}

internal const val MAX_MOBILE_UPDATE_BYTES = 512L * 1024L * 1024L
private const val UPDATE_VERIFY_BUFFER_SIZE = 32 * 1024

internal class MobileUpdateDownloadFailure(
    val code: String,
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)
