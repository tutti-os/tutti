package sh.tutti.mobile

import android.app.Activity
import android.content.pm.PackageInstaller

internal const val MOBILE_UPDATE_INSTALL_RESULT_EXTRA =
    "android.intent.extra.INSTALL_RESULT"

internal enum class MobileUpdateInstallOutcomeKind {
    CANCELLED,
    COMPLETED,
    FAILED,
}

internal data class MobileUpdateInstallOutcome(
    val errorCode: String?,
    val kind: MobileUpdateInstallOutcomeKind,
)

// EXTRA_INSTALL_RESULT and PackageManager's legacy install codes are hidden
// from public SDK stubs. Mirror PackageManager.installStatusToPublicStatus.
internal fun packageInstallerStatusForInstallResult(installResult: Int): Int =
    when (installResult) {
        1 -> PackageInstaller.STATUS_SUCCESS
        -1, -5, -6, -7, -8, -10, -13, -112, -126 ->
            PackageInstaller.STATUS_FAILURE_CONFLICT
        -2, -3, -11, -15, -23, -24, -25, -26,
        in -109..-100,
        -117, -118,
        -> PackageInstaller.STATUS_FAILURE_INVALID
        -4, -18, -19, -20 -> PackageInstaller.STATUS_FAILURE_STORAGE
        -9, -12, -14, -16, -17, -28, -29, -111, -113 ->
            PackageInstaller.STATUS_FAILURE_INCOMPATIBLE
        -21, -22, -115 -> PackageInstaller.STATUS_FAILURE_ABORTED
        -129 -> PackageInstaller.STATUS_FAILURE_BLOCKED
        else -> PackageInstaller.STATUS_FAILURE
    }

internal fun classifyMobileUpdateInstallOutcome(
    resultCode: Int,
    packageInstallerStatus: Int?,
): MobileUpdateInstallOutcome {
    if (
        resultCode == Activity.RESULT_OK ||
        packageInstallerStatus == PackageInstaller.STATUS_SUCCESS
    ) {
        return MobileUpdateInstallOutcome(null, MobileUpdateInstallOutcomeKind.COMPLETED)
    }
    if (resultCode == Activity.RESULT_CANCELED && packageInstallerStatus == null) {
        return MobileUpdateInstallOutcome(null, MobileUpdateInstallOutcomeKind.CANCELLED)
    }
    val errorCode =
        when (packageInstallerStatus) {
            PackageInstaller.STATUS_FAILURE_STORAGE ->
                "UPDATE_INSTALL_STORAGE_INSUFFICIENT"
            PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
                "UPDATE_INSTALL_INCOMPATIBLE"
            PackageInstaller.STATUS_FAILURE_CONFLICT ->
                "UPDATE_INSTALL_CONFLICT"
            PackageInstaller.STATUS_FAILURE_BLOCKED ->
                "UPDATE_INSTALL_BLOCKED"
            PackageInstaller.STATUS_FAILURE_INVALID ->
                "UPDATE_INSTALL_PACKAGE_INVALID"
            else -> "UPDATE_INSTALL_FAILED"
        }
    return MobileUpdateInstallOutcome(errorCode, MobileUpdateInstallOutcomeKind.FAILED)
}
