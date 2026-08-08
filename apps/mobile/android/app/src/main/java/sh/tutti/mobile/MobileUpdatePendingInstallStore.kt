package sh.tutti.mobile

import android.content.Context
import android.content.SharedPreferences
import android.os.Environment
import android.util.Log
import java.io.File

internal class MobileUpdatePendingInstallStore(
    private val context: Context,
    private val preferences: SharedPreferences,
) {
    fun persist(request: MobileUpdateArtifactRequest) {
        val persisted =
            preferences.edit()
                .putString(KEY_PENDING_INSTALL_SHA256, request.expectedSHA256)
                .putInt(KEY_PENDING_INSTALL_VERSION_CODE, request.targetVersionCode)
                .commit()
        if (!persisted) {
            throw MobileUpdateDownloadFailure(
                "UPDATE_CACHE_FAILED",
                "Unable to persist the pending Android update",
            )
        }
    }

    fun cleanupInstalledArtifact(installedVersionCode: Int) {
        val pending = readPending() ?: return
        val artifactFile = artifactFile(pending.expectedSHA256) ?: return
        if (!artifactFile.exists()) {
            clear()
            return
        }
        if (shouldCleanupPendingMobileUpdate(installedVersionCode, pending.targetVersionCode)) {
            deleteArtifact()
        }
    }

    fun deleteArtifact() {
        val pending = readPending() ?: return
        val artifactFile = artifactFile(pending.expectedSHA256)
        if (artifactFile == null || !artifactFile.exists() || artifactFile.delete()) {
            clear()
        } else {
            Log.w(LOG_TAG, "Unable to delete installed Android update ${artifactFile.name}")
        }
    }

    fun clearIfMatches(request: MobileUpdateArtifactRequest) {
        val pending = readPending() ?: return
        if (
            pending.expectedSHA256 == request.expectedSHA256 &&
            pending.targetVersionCode == request.targetVersionCode
        ) {
            clear()
        }
    }

    private fun readPending(): PendingInstall? {
        val expectedSHA256 = preferences.getString(KEY_PENDING_INSTALL_SHA256, null)
        val targetVersionCode = preferences.getInt(KEY_PENDING_INSTALL_VERSION_CODE, -1)
        if (
            expectedSHA256 == null ||
            !expectedSHA256.matches(Regex("[a-f0-9]{64}")) ||
            targetVersionCode <= 0
        ) {
            clear()
            return null
        }
        return PendingInstall(expectedSHA256, targetVersionCode)
    }

    private fun artifactFile(expectedSHA256: String): File? =
        context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)?.let { downloads ->
            File(File(downloads, "updates"), mobileUpdateArtifactFileName(expectedSHA256))
        }

    private fun clear() {
        preferences.edit()
            .remove(KEY_PENDING_INSTALL_SHA256)
            .remove(KEY_PENDING_INSTALL_VERSION_CODE)
            .apply()
    }

    private data class PendingInstall(
        val expectedSHA256: String,
        val targetVersionCode: Int,
    )

    private companion object {
        const val KEY_PENDING_INSTALL_SHA256 = "pending_install_sha256"
        const val KEY_PENDING_INSTALL_VERSION_CODE = "pending_install_version_code"
        const val LOG_TAG = "TuttiMobileSecurity"
    }
}

internal fun shouldCleanupPendingMobileUpdate(
    installedVersionCode: Int,
    targetVersionCode: Int,
): Boolean = targetVersionCode > 0 && installedVersionCode >= targetVersionCode
