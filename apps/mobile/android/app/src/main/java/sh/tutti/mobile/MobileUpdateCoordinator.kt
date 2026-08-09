package sh.tutti.mobile

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.UiThreadUtil
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

internal data class MobileUpdateProgressEvent(
    val downloadedBytes: Long,
    val errorCode: String? = null,
    val indeterminate: Boolean,
    val phase: String,
    val totalBytes: Long?,
)

internal fun mobileUpdateDownloadFailureForReason(
    reason: Int,
): MobileUpdateDownloadFailure =
    when (reason) {
        DownloadManager.ERROR_INSUFFICIENT_SPACE ->
            MobileUpdateDownloadFailure(
                "UPDATE_STORAGE_INSUFFICIENT",
                "Android has insufficient storage for the update",
            )
        DownloadManager.ERROR_DEVICE_NOT_FOUND,
        DownloadManager.ERROR_FILE_ALREADY_EXISTS,
        DownloadManager.ERROR_FILE_ERROR,
        ->
            MobileUpdateDownloadFailure(
                "UPDATE_DOWNLOAD_FILE_FAILED",
                "Android could not write the update package",
            )
        DownloadManager.ERROR_CANNOT_RESUME,
        DownloadManager.ERROR_HTTP_DATA_ERROR,
        DownloadManager.ERROR_TOO_MANY_REDIRECTS,
        DownloadManager.ERROR_UNHANDLED_HTTP_CODE,
        ->
            MobileUpdateDownloadFailure(
                "UPDATE_DOWNLOAD_SERVER_FAILED",
                "The update server could not complete the download",
            )
        else ->
            MobileUpdateDownloadFailure(
                "UPDATE_DOWNLOAD_MANAGER_FAILED",
                "Android DownloadManager failed with reason $reason",
            )
    }

internal class MobileUpdateCoordinator(
    private val reactContext: ReactApplicationContext,
    private val publishProgress: (MobileUpdateProgressEvent) -> Unit,
) : LifecycleEventListener {
    private val downloadManager =
        reactContext.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
    private val preferences =
        reactContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private val pendingInstallStore =
        MobileUpdatePendingInstallStore(reactContext, preferences)
    private val executor = Executors.newSingleThreadScheduledExecutor()
    private val lock = Any()
    private var activeUpdate: ActiveUpdate? = null
    @Volatile private var invalidated = false
    private val completionReceiver =
        object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent?.action != DownloadManager.ACTION_DOWNLOAD_COMPLETE) return
                val downloadId =
                    intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
                val update = synchronized(lock) { activeUpdate }
                if (update?.downloadId == downloadId) {
                    completeDownload(update)
                }
            }
        }

    init {
        reactContext.addLifecycleEventListener(this)
        ContextCompat.registerReceiver(
            reactContext,
            completionReceiver,
            IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
            ContextCompat.RECEIVER_EXPORTED,
        )
        executor.scheduleWithFixedDelay(
            ::pollActiveDownload,
            0,
            PROGRESS_POLL_INTERVAL_MS,
            TimeUnit.MILLISECONDS,
        )
        executor.execute {
            pendingInstallStore.cleanupInstalledArtifact(BuildConfig.VERSION_CODE)
        }
    }

    fun install(
        apkURL: String,
        expectedSHA256: String,
        expectedSizeBytes: Double,
        targetVersionCode: Double,
        promise: Promise,
    ) {
        val request = try {
            validateMobileUpdateArtifactRequest(
                apkURL,
                expectedSHA256,
                expectedSizeBytes,
                targetVersionCode,
            )
        } catch (cause: MobileUpdateDownloadFailure) {
            promise.reject(cause.code, cause.message, cause)
            return
        }
        val artifactFile = try {
            prepareArtifactFile(request)
        } catch (cause: MobileUpdateDownloadFailure) {
            promise.reject(cause.code, cause.message, cause)
            return
        }
        val update = ActiveUpdate(request, artifactFile, promise)
        synchronized(lock) {
            if (invalidated) {
                promise.reject("UPDATE_INSTALL_FAILED", "The update module is unavailable")
                return
            }
            if (activeUpdate != null) {
                promise.reject("UPDATE_IN_PROGRESS", "An Android update is already in progress")
                return
            }
            activeUpdate = update
        }
        publish(update, PHASE_PREPARING, 0, request.expectedSizeBytes)
        executor.execute { restoreOrStartDownload(update) }
    }

    fun cancel(promise: Promise) {
        val cancellation = synchronized(lock) {
            val current = activeUpdate
            if (current?.installerHandoffStarted == true) {
                return@synchronized Cancellation(null, null, unavailable = true)
            }
            val persistedId = preferences.getLong(KEY_DOWNLOAD_ID, -1L)
            activeUpdate = null
            current?.cancelled = true
            Cancellation(current, persistedId.takeIf { it >= 0 }, unavailable = false)
        }
        if (cancellation.unavailable) {
            promise.reject(
                "UPDATE_CANCEL_UNAVAILABLE",
                "The Android package installer has already started",
            )
            return
        }
        setOfNotNull(cancellation.persistedDownloadId, cancellation.update?.downloadId)
            .forEach { downloadId -> downloadManager.remove(downloadId) }
        clearPersistedDownload()
        val update = cancellation.update
        if (update != null) {
            update.artifactFile.delete()
            pendingInstallStore.clearIfMatches(update.request)
            publishProgress(
                MobileUpdateProgressEvent(
                    downloadedBytes = 0,
                    indeterminate = true,
                    phase = PHASE_CANCELLED,
                    totalBytes = null,
                ),
            )
            rejectOnce(update, "UPDATE_CANCELLED", "Android update download cancelled")
        }
        promise.resolve(null)
    }

    fun onActivityResult(
        requestCode: Int,
        resultCode: Int,
        intent: Intent?,
    ): Boolean {
        if (requestCode != INSTALL_REQUEST_CODE) return false
        val installResult =
            intent?.takeIf { it.hasExtra(MOBILE_UPDATE_INSTALL_RESULT_EXTRA) }
                ?.getIntExtra(MOBILE_UPDATE_INSTALL_RESULT_EXTRA, 0)
        val packageInstallerStatus =
            if (installResult != null) {
                packageInstallerStatusForInstallResult(installResult)
            } else {
                intent?.takeIf { it.hasExtra(PackageInstaller.EXTRA_STATUS) }
                    ?.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
            }
        val outcome = classifyMobileUpdateInstallOutcome(resultCode, packageInstallerStatus)
        val phase =
            when (outcome.kind) {
                MobileUpdateInstallOutcomeKind.CANCELLED -> PHASE_CANCELLED
                MobileUpdateInstallOutcomeKind.COMPLETED -> PHASE_COMPLETED
                MobileUpdateInstallOutcomeKind.FAILED -> PHASE_FAILED
            }
        Log.i(
            LOG_TAG,
            "Android package installer finished: resultCode=$resultCode, " +
                "installResult=$installResult, status=$packageInstallerStatus, " +
                "outcome=${outcome.kind}",
        )
        if (outcome.kind == MobileUpdateInstallOutcomeKind.COMPLETED) {
            pendingInstallStore.deleteArtifact()
        }
        publishProgress(
            MobileUpdateProgressEvent(
                downloadedBytes = 0,
                errorCode = outcome.errorCode,
                indeterminate = true,
                phase = phase,
                totalBytes = null,
            ),
        )
        return true
    }

    override fun onHostResume() {
        val update = synchronized(lock) {
            activeUpdate?.takeIf { it.awaitingInstallPermission && !it.cancelled }
        } ?: return
        update.awaitingInstallPermission = false
        if (
            Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            reactContext.packageManager.canRequestPackageInstalls()
        ) {
            launchInstaller(update)
        } else {
            fail(
                update,
                MobileUpdateDownloadFailure(
                    "UPDATE_INSTALL_PERMISSION_REQUIRED",
                    "Allow Tutti to install unknown apps, then try again",
                ),
                deleteArtifact = false,
            )
        }
    }

    override fun onHostPause() = Unit

    override fun onHostDestroy() = Unit

    fun invalidate() {
        synchronized(lock) {
            invalidated = true
            activeUpdate = null
        }
        reactContext.removeLifecycleEventListener(this)
        runCatching { reactContext.unregisterReceiver(completionReceiver) }
        executor.shutdownNow()
    }

    private fun restoreOrStartDownload(update: ActiveUpdate) {
        if (!isActive(update)) return
        if (restorePersistedDownload(update)) return
        if (update.artifactFile.exists()) {
            try {
                publish(update, PHASE_VERIFYING, update.request.expectedSizeBytes, update.request.expectedSizeBytes)
                verifyMobileUpdateArtifact(update.artifactFile, update.request)
                discardOtherArtifacts(update.artifactFile)
                launchInstaller(update)
                return
            } catch (cause: MobileUpdateDownloadFailure) {
                Log.w(LOG_TAG, "Discarding invalid cached Android update", cause)
                if (!update.artifactFile.delete()) {
                    fail(
                        update,
                        MobileUpdateDownloadFailure(
                            "UPDATE_CACHE_REPLACE_FAILED",
                            "Unable to replace the cached Android update",
                            cause,
                        ),
                    )
                    return
                }
            }
        }
        discardOtherArtifacts(update.artifactFile)
        try {
            ensureDownloadStorage(update)
        } catch (cause: MobileUpdateDownloadFailure) {
            fail(update, cause)
            return
        }
        enqueueDownload(update)
    }

    private fun restorePersistedDownload(update: ActiveUpdate): Boolean {
        val persistedId = preferences.getLong(KEY_DOWNLOAD_ID, -1L)
        if (persistedId < 0) return false
        val matches =
            preferences.getString(KEY_SHA256, null) == update.request.expectedSHA256 &&
                preferences.getString(KEY_URL, null) == update.request.url.toString() &&
                preferences.getLong(KEY_SIZE_BYTES, -1L) == update.request.expectedSizeBytes
        if (!matches) {
            downloadManager.remove(persistedId)
            clearPersistedDownload()
            return false
        }
        val snapshot = queryDownload(persistedId)
        if (!claimPersistedDownload(update, persistedId)) {
            downloadManager.remove(persistedId)
            return true
        }
        if (snapshot == null || snapshot.status == DownloadManager.STATUS_FAILED) {
            downloadManager.remove(persistedId)
            clearPersistedDownload()
            update.artifactFile.delete()
            return false
        }
        if (snapshot.status == DownloadManager.STATUS_SUCCESSFUL) {
            completeDownload(update)
        } else {
            publishSnapshot(update, snapshot)
        }
        return true
    }

    private fun enqueueDownload(update: ActiveUpdate) {
        if (!isActive(update)) return
        val request =
            DownloadManager.Request(Uri.parse(update.request.url.toString()))
                .addRequestHeader("Accept", APK_MIME_TYPE)
                .setAllowedOverMetered(true)
                .setAllowedOverRoaming(false)
                .setDestinationUri(Uri.fromFile(update.artifactFile))
                .setMimeType(APK_MIME_TYPE)
                .setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED,
                )
                .setTitle(reactContext.getString(R.string.update_download_title))
                .setDescription(reactContext.getString(R.string.update_download_description))
        val downloadId = try {
            downloadManager.enqueue(request)
        } catch (cause: Throwable) {
            fail(
                update,
                MobileUpdateDownloadFailure(
                    "UPDATE_DOWNLOAD_MANAGER_FAILED",
                    "Unable to schedule the Android update download",
                    cause,
                ),
            )
            return
        }
        val claimed = synchronized(lock) {
            if (invalidated || update.cancelled || activeUpdate !== update) {
                false
            } else {
                update.downloadId = downloadId
                preferences.edit()
                    .putLong(KEY_DOWNLOAD_ID, downloadId)
                    .putString(KEY_SHA256, update.request.expectedSHA256)
                    .putLong(KEY_SIZE_BYTES, update.request.expectedSizeBytes)
                    .putString(KEY_URL, update.request.url.toString())
                    .apply()
                true
            }
        }
        if (!claimed) {
            downloadManager.remove(downloadId)
            update.artifactFile.delete()
            return
        }
        Log.i(
            LOG_TAG,
            "Android update download enqueued: id=$downloadId, " +
                "host=${update.request.url.host}, expectedBytes=${update.request.expectedSizeBytes}",
        )
        publish(update, PHASE_QUEUED, 0, update.request.expectedSizeBytes)
    }

    private fun pollActiveDownload() {
        val update = synchronized(lock) { activeUpdate } ?: return
        val downloadId = update.downloadId ?: return
        val snapshot = queryDownload(downloadId)
        if (snapshot == null) {
            update.queryFailureCount += 1
            if (update.queryFailureCount >= MAX_CONSECUTIVE_QUERY_FAILURES) {
                fail(
                    update,
                    MobileUpdateDownloadFailure(
                        "UPDATE_DOWNLOAD_QUERY_FAILED",
                        "Unable to read Android update download status",
                    ),
                )
            }
            return
        }
        update.queryFailureCount = 0
        when (snapshot.status) {
            DownloadManager.STATUS_SUCCESSFUL -> completeDownload(update)
            DownloadManager.STATUS_FAILED ->
                fail(
                    update,
                    mobileUpdateDownloadFailureForReason(snapshot.reason),
                )
            else -> publishSnapshot(update, snapshot)
        }
    }

    private fun publishSnapshot(update: ActiveUpdate, snapshot: DownloadSnapshot) {
        val reportedTotal = snapshot.totalBytes.takeIf { it > 0 }
        if (reportedTotal != null && reportedTotal != update.request.expectedSizeBytes) {
            fail(
                update,
                MobileUpdateDownloadFailure(
                    "UPDATE_SIZE_MISMATCH",
                    "Update response size does not match the release manifest",
                ),
            )
            return
        }
        if (snapshot.downloadedBytes > update.request.expectedSizeBytes) {
            fail(
                update,
                MobileUpdateDownloadFailure(
                    "UPDATE_SIZE_MISMATCH",
                    "Update download exceeded the release manifest size",
                ),
            )
            return
        }
        val phase =
            when (snapshot.status) {
                DownloadManager.STATUS_PENDING -> PHASE_QUEUED
                DownloadManager.STATUS_PAUSED -> PHASE_PAUSED
                else -> PHASE_DOWNLOADING
            }
        publish(
            update,
            phase,
            snapshot.downloadedBytes.coerceAtLeast(0),
            update.request.expectedSizeBytes,
        )
    }

    private fun completeDownload(update: ActiveUpdate) {
        if (!update.completionStarted.compareAndSet(false, true)) return
        executor.execute {
            if (!isActive(update)) return@execute
            try {
                publish(
                    update,
                    PHASE_VERIFYING,
                    update.request.expectedSizeBytes,
                    update.request.expectedSizeBytes,
                )
                verifyMobileUpdateArtifact(update.artifactFile, update.request)
                discardOtherArtifacts(update.artifactFile)
                clearPersistedDownload()
                launchInstaller(update)
            } catch (cause: MobileUpdateDownloadFailure) {
                fail(update, cause)
            }
        }
    }

    private fun launchInstaller(update: ActiveUpdate) {
        UiThreadUtil.runOnUiThread {
            if (!isActive(update)) return@runOnUiThread
            try {
                pendingInstallStore.persist(update.request)
            } catch (cause: MobileUpdateDownloadFailure) {
                fail(update, cause, deleteArtifact = false)
                return@runOnUiThread
            }
            val activity = reactContext.currentActivity
            if (activity == null) {
                fail(
                    update,
                    MobileUpdateDownloadFailure(
                        "UPDATE_INSTALL_DEFERRED",
                        "Return to Tutti to continue installing the downloaded update",
                    ),
                    deleteArtifact = false,
                )
                return@runOnUiThread
            }
            if (
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                !reactContext.packageManager.canRequestPackageInstalls()
            ) {
                update.awaitingInstallPermission = true
                publish(
                    update,
                    PHASE_AWAITING_INSTALL_PERMISSION,
                    update.request.expectedSizeBytes,
                    update.request.expectedSizeBytes,
                )
                try {
                    activity.startActivity(
                        Intent(
                            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:${reactContext.packageName}"),
                        ),
                    )
                } catch (cause: Throwable) {
                    update.awaitingInstallPermission = false
                    fail(
                        update,
                        MobileUpdateDownloadFailure(
                            "UPDATE_PERMISSION_SETTINGS_FAILED",
                            "Unable to open Android install permission settings",
                            cause,
                        ),
                        deleteArtifact = false,
                    )
                    return@runOnUiThread
                }
                return@runOnUiThread
            }
            publish(
                update,
                PHASE_OPENING_INSTALLER,
                update.request.expectedSizeBytes,
                update.request.expectedSizeBytes,
            )
            val uri = try {
                FileProvider.getUriForFile(
                    reactContext,
                    "${BuildConfig.APPLICATION_ID}.fileprovider",
                    update.artifactFile,
                )
            } catch (cause: Throwable) {
                fail(
                    update,
                    MobileUpdateDownloadFailure(
                        "UPDATE_URI_FAILED",
                        "Unable to prepare the Android update file",
                        cause,
                    ),
                )
                return@runOnUiThread
            }
            if (!claimInstallerHandoff(update)) {
                pendingInstallStore.clearIfMatches(update.request)
                return@runOnUiThread
            }
            try {
                activity.startActivityForResult(
                    Intent(Intent.ACTION_VIEW).apply {
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        putExtra(Intent.EXTRA_RETURN_RESULT, true)
                        setDataAndType(uri, APK_MIME_TYPE)
                    },
                    INSTALL_REQUEST_CODE,
                )
                publish(
                    update,
                    PHASE_AWAITING_INSTALL_CONFIRMATION,
                    update.request.expectedSizeBytes,
                    update.request.expectedSizeBytes,
                )
                resolveOnce(update)
                clearActive(update)
            } catch (cause: Throwable) {
                fail(
                    update,
                    MobileUpdateDownloadFailure(
                        "UPDATE_INSTALLER_LAUNCH_FAILED",
                        "Unable to open the Android package installer",
                        cause,
                    ),
                    deleteArtifact = false,
                )
            }
        }
    }

    private fun prepareArtifactFile(request: MobileUpdateArtifactRequest): File {
        val downloadsDirectory =
            reactContext.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
                ?: throw MobileUpdateDownloadFailure(
                    "UPDATE_CACHE_FAILED",
                    "Android update storage is unavailable",
                )
        val updateDirectory = File(downloadsDirectory, "updates")
        if (!updateDirectory.mkdirs() && !updateDirectory.isDirectory) {
            throw MobileUpdateDownloadFailure(
                "UPDATE_CACHE_FAILED",
                "Unable to create update download directory",
            )
        }
        return File(updateDirectory, request.fileName)
    }

    private fun discardOtherArtifacts(currentArtifact: File) {
        currentArtifact.parentFile?.listFiles()?.forEach { candidate ->
            if (
                candidate != currentArtifact &&
                candidate.isFile &&
                candidate.name.startsWith(UPDATE_FILE_PREFIX) &&
                candidate.name.endsWith(UPDATE_FILE_SUFFIX) &&
                !candidate.delete()
            ) {
                Log.w(LOG_TAG, "Unable to delete stale Android update ${candidate.name}")
            }
        }
    }

    private fun ensureDownloadStorage(update: ActiveUpdate) {
        val availableBytes = StatFs(update.artifactFile.parentFile!!.absolutePath).availableBytes
        if (
            availableBytes <
            update.request.expectedSizeBytes + MIN_FREE_BYTES_AFTER_DOWNLOAD
        ) {
            throw MobileUpdateDownloadFailure(
                "UPDATE_STORAGE_INSUFFICIENT",
                "Not enough storage is available for the Android update",
            )
        }
    }

    private fun queryDownload(downloadId: Long): DownloadSnapshot? {
        val query = DownloadManager.Query().setFilterById(downloadId)
        return try {
            downloadManager.query(query)?.use { cursor ->
                if (!cursor.moveToFirst()) return@use null
                DownloadSnapshot(
                    downloadedBytes =
                        cursor.getLong(
                            cursor.getColumnIndexOrThrow(
                                DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR,
                            ),
                        ),
                    reason =
                        cursor.getInt(
                            cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON),
                        ),
                    status =
                        cursor.getInt(
                            cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS),
                        ),
                    totalBytes =
                        cursor.getLong(
                            cursor.getColumnIndexOrThrow(
                                DownloadManager.COLUMN_TOTAL_SIZE_BYTES,
                            ),
                        ),
                )
            }
        } catch (cause: Throwable) {
            Log.w(LOG_TAG, "Unable to query Android update download $downloadId", cause)
            null
        }
    }

    private fun publish(
        update: ActiveUpdate,
        phase: String,
        downloadedBytes: Long,
        totalBytes: Long,
    ) {
        if (!isActive(update)) return
        val key = "$phase:$downloadedBytes:$totalBytes"
        if (update.lastProgressKey == key) return
        update.lastProgressKey = key
        publishProgress(
            MobileUpdateProgressEvent(
                downloadedBytes = downloadedBytes,
                indeterminate = phase != PHASE_DOWNLOADING || totalBytes <= 0,
                phase = phase,
                totalBytes = totalBytes.takeIf { it > 0 },
            ),
        )
    }

    private fun fail(
        update: ActiveUpdate,
        failure: MobileUpdateDownloadFailure,
        deleteArtifact: Boolean = true,
    ) {
        if (update.settled.get()) return
        update.downloadId?.let { downloadId -> downloadManager.remove(downloadId) }
        clearPersistedDownload()
        if (deleteArtifact) {
            update.artifactFile.delete()
            pendingInstallStore.clearIfMatches(update.request)
        }
        Log.e(LOG_TAG, "Android update failed: code=${failure.code}", failure)
        rejectOnce(update, failure.code, failure.message ?: "Android update failed", failure)
        clearActive(update)
    }

    private fun resolveOnce(update: ActiveUpdate) {
        if (update.settled.compareAndSet(false, true)) {
            update.promise.resolve(null)
        }
    }

    private fun rejectOnce(
        update: ActiveUpdate,
        code: String,
        message: String,
        cause: Throwable? = null,
    ) {
        if (update.settled.compareAndSet(false, true)) {
            update.promise.reject(code, message, cause)
        }
    }

    private fun clearActive(update: ActiveUpdate) {
        synchronized(lock) {
            if (activeUpdate === update) activeUpdate = null
        }
    }

    private fun claimPersistedDownload(
        update: ActiveUpdate,
        downloadId: Long,
    ): Boolean =
        synchronized(lock) {
            if (invalidated || update.cancelled || activeUpdate !== update) {
                false
            } else {
                update.downloadId = downloadId
                true
            }
        }

    private fun claimInstallerHandoff(update: ActiveUpdate): Boolean =
        synchronized(lock) {
            if (invalidated || update.cancelled || activeUpdate !== update) {
                false
            } else {
                update.installerHandoffStarted = true
                true
            }
        }

    private fun isActive(update: ActiveUpdate): Boolean =
        synchronized(lock) {
            !invalidated && !update.cancelled && activeUpdate === update
        }

    private fun clearPersistedDownload() {
        preferences.edit()
            .remove(KEY_DOWNLOAD_ID)
            .remove(KEY_SHA256)
            .remove(KEY_SIZE_BYTES)
            .remove(KEY_URL)
            .apply()
    }

    private data class DownloadSnapshot(
        val downloadedBytes: Long,
        val reason: Int,
        val status: Int,
        val totalBytes: Long,
    )

    private data class Cancellation(
        val update: ActiveUpdate?,
        val persistedDownloadId: Long?,
        val unavailable: Boolean,
    )

    private class ActiveUpdate(
        val request: MobileUpdateArtifactRequest,
        val artifactFile: File,
        val promise: Promise,
    ) {
        @Volatile var cancelled = false
        @Volatile var awaitingInstallPermission = false
        @Volatile var downloadId: Long? = null
        @Volatile var installerHandoffStarted = false
        @Volatile var lastProgressKey = ""
        @Volatile var queryFailureCount = 0
        val completionStarted = AtomicBoolean(false)
        val settled = AtomicBoolean(false)
    }

    companion object {
        const val EVENT_NAME = "TuttiMobileUpdateProgress"
        private const val APK_MIME_TYPE = "application/vnd.android.package-archive"
        private const val INSTALL_REQUEST_CODE = 61041
        private const val KEY_DOWNLOAD_ID = "download_id"
        private const val KEY_SHA256 = "sha256"
        private const val KEY_SIZE_BYTES = "size_bytes"
        private const val KEY_URL = "url"
        private const val LOG_TAG = "TuttiMobileSecurity"
        private const val MAX_CONSECUTIVE_QUERY_FAILURES = 40
        private const val MIN_FREE_BYTES_AFTER_DOWNLOAD = 32L * 1024L * 1024L
        private const val PHASE_AWAITING_INSTALL_CONFIRMATION =
            "awaiting_install_confirmation"
        private const val PHASE_AWAITING_INSTALL_PERMISSION =
            "awaiting_install_permission"
        private const val PHASE_CANCELLED = "cancelled"
        private const val PHASE_COMPLETED = "completed"
        private const val PHASE_DOWNLOADING = "downloading"
        private const val PHASE_FAILED = "failed"
        private const val PHASE_OPENING_INSTALLER = "opening_installer"
        private const val PHASE_PAUSED = "paused"
        private const val PHASE_PREPARING = "preparing"
        private const val PHASE_QUEUED = "queued"
        private const val PHASE_VERIFYING = "verifying"
        private const val PREFERENCES_NAME = "tutti_mobile_update"
        private const val PROGRESS_POLL_INTERVAL_MS = 250L
        private const val UPDATE_FILE_PREFIX = "tutti-update-"
        private const val UPDATE_FILE_SUFFIX = ".apk"
    }
}
