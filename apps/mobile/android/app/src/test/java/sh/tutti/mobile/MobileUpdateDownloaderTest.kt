package sh.tutti.mobile

import android.app.Activity
import android.app.DownloadManager
import android.content.pm.PackageInstaller
import java.io.File
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class MobileUpdateDownloaderTest {
    @get:Rule val temporaryFolder = TemporaryFolder()

    @Test
    fun `accepts a bounded HTTPS artifact request`() {
        val request =
            validateMobileUpdateArtifactRequest(
                "https://updates.example.test/app.apk",
                "a".repeat(64),
                1024.0,
                2.0,
            )

        assertEquals(1024L, request.expectedSizeBytes)
        assertEquals(2, request.targetVersionCode)
        assertEquals("tutti-update-${"a".repeat(64)}.apk", request.fileName)
    }

    @Test(expected = MobileUpdateDownloadFailure::class)
    fun `rejects HTTP update URLs`() {
        validateMobileUpdateArtifactRequest(
            "http://updates.example.test/app.apk",
            "a".repeat(64),
            1024.0,
            2.0,
        )
    }

    @Test(expected = MobileUpdateDownloadFailure::class)
    fun `rejects update URLs with embedded credentials`() {
        validateMobileUpdateArtifactRequest(
            "https://user:secret@updates.example.test/app.apk",
            "a".repeat(64),
            1024.0,
            2.0,
        )
    }

    @Test(expected = MobileUpdateDownloadFailure::class)
    fun `rejects oversized artifacts`() {
        validateMobileUpdateArtifactRequest(
            "https://updates.example.test/app.apk",
            "a".repeat(64),
            (MAX_MOBILE_UPDATE_BYTES + 1).toDouble(),
            2.0,
        )
    }

    @Test(expected = MobileUpdateDownloadFailure::class)
    fun `rejects an invalid target version code`() {
        validateMobileUpdateArtifactRequest(
            "https://updates.example.test/app.apk",
            "a".repeat(64),
            1024.0,
            0.0,
        )
    }

    @Test
    fun `verifies artifact size and checksum`() {
        val content = "verified apk".toByteArray()
        val file = File(temporaryFolder.root, "app.apk").apply { writeBytes(content) }
        val sha256 =
            MessageDigest.getInstance("SHA-256").digest(content).joinToString("") { byte ->
                "%02x".format(byte.toInt() and 0xff)
            }
        val request =
            validateMobileUpdateArtifactRequest(
                "https://updates.example.test/app.apk",
                sha256,
                content.size.toDouble(),
                2.0,
            )

        verifyMobileUpdateArtifact(file, request)
    }

    @Test
    fun `rejects an artifact whose size differs from the manifest`() {
        val file = File(temporaryFolder.root, "wrong-size.apk").apply { writeText("apk") }
        val request =
            validateMobileUpdateArtifactRequest(
                "https://updates.example.test/app.apk",
                "a".repeat(64),
                4.0,
                2.0,
            )

        val failure =
            assertThrows(MobileUpdateDownloadFailure::class.java) {
                verifyMobileUpdateArtifact(file, request)
            }

        assertEquals("UPDATE_SIZE_MISMATCH", failure.code)
    }

    @Test
    fun `rejects an artifact whose checksum differs from the manifest`() {
        val file = File(temporaryFolder.root, "wrong-sha.apk").apply { writeText("apk") }
        val request =
            validateMobileUpdateArtifactRequest(
                "https://updates.example.test/app.apk",
                "a".repeat(64),
                file.length().toDouble(),
                2.0,
            )

        val failure =
            assertThrows(MobileUpdateDownloadFailure::class.java) {
                verifyMobileUpdateArtifact(file, request)
            }

        assertEquals("UPDATE_CHECKSUM_FAILED", failure.code)
    }

    @Test
    fun `classifies package installer cancellation separately from failure`() {
        val cancelled =
            classifyMobileUpdateInstallOutcome(
                Activity.RESULT_CANCELED,
                null,
            )
        val conflict =
            classifyMobileUpdateInstallOutcome(
                Activity.RESULT_FIRST_USER,
                packageInstallerStatusForInstallResult(-7),
            )
        val aborted =
            classifyMobileUpdateInstallOutcome(
                Activity.RESULT_FIRST_USER,
                packageInstallerStatusForInstallResult(-115),
            )

        assertEquals(MobileUpdateInstallOutcomeKind.CANCELLED, cancelled.kind)
        assertEquals(MobileUpdateInstallOutcomeKind.FAILED, conflict.kind)
        assertEquals("UPDATE_INSTALL_CONFLICT", conflict.errorCode)
        assertEquals(MobileUpdateInstallOutcomeKind.FAILED, aborted.kind)
        assertEquals("UPDATE_INSTALL_FAILED", aborted.errorCode)
    }

    @Test
    fun `maps legacy package manager install results to public statuses`() {
        assertEquals(
            PackageInstaller.STATUS_FAILURE_STORAGE,
            packageInstallerStatusForInstallResult(-4),
        )
        assertEquals(
            PackageInstaller.STATUS_FAILURE_CONFLICT,
            packageInstallerStatusForInstallResult(-7),
        )
        assertEquals(
            PackageInstaller.STATUS_FAILURE_INCOMPATIBLE,
            packageInstallerStatusForInstallResult(-12),
        )
        assertEquals(
            PackageInstaller.STATUS_FAILURE_BLOCKED,
            packageInstallerStatusForInstallResult(-129),
        )
        assertEquals(
            PackageInstaller.STATUS_FAILURE_INVALID,
            packageInstallerStatusForInstallResult(-2),
        )
    }

    @Test
    fun `cleans a pending artifact only after the target version is installed`() {
        assertEquals(false, shouldCleanupPendingMobileUpdate(41, 42))
        assertEquals(true, shouldCleanupPendingMobileUpdate(42, 42))
        assertEquals(true, shouldCleanupPendingMobileUpdate(43, 42))
    }

    @Test
    fun `maps system download reasons to actionable failures`() {
        assertEquals(
            "UPDATE_STORAGE_INSUFFICIENT",
            mobileUpdateDownloadFailureForReason(
                DownloadManager.ERROR_INSUFFICIENT_SPACE,
            ).code,
        )
        assertEquals(
            "UPDATE_DOWNLOAD_FILE_FAILED",
            mobileUpdateDownloadFailureForReason(DownloadManager.ERROR_FILE_ERROR).code,
        )
        assertEquals(
            "UPDATE_DOWNLOAD_SERVER_FAILED",
            mobileUpdateDownloadFailureForReason(
                DownloadManager.ERROR_UNHANDLED_HTTP_CODE,
            ).code,
        )
    }
}
