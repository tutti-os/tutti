package sh.tutti.mobile

import android.content.Context
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class MobilePreferencesModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    private val preferences =
        reactContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    override fun getName(): String = MODULE_NAME

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun loadThemePreference(): String =
        normalizeThemePreference(preferences.getString(THEME_PREFERENCE, null))

    @ReactMethod
    fun saveThemePreference(
        preference: String,
        promise: Promise,
    ) {
        if (preference !in SUPPORTED_THEME_PREFERENCES) {
            promise.reject(
                "INVALID_THEME_PREFERENCE",
                "Unsupported Mobile theme preference",
            )
            return
        }
        if (preferences.edit().putString(THEME_PREFERENCE, preference).commit()) {
            promise.resolve(null)
        } else {
            promise.reject(
                "THEME_PREFERENCE_WRITE_FAILED",
                "Unable to save Mobile theme preference",
            )
        }
    }

    companion object {
        private const val MODULE_NAME = "TuttiMobilePreferences"
        private const val PREFERENCES_NAME = "tutti_mobile_preferences"
        private const val THEME_PREFERENCE = "theme_preference"
        private val SUPPORTED_THEME_PREFERENCES = setOf("system", "light", "dark")

        private fun normalizeThemePreference(value: String?): String =
            value?.takeIf(SUPPORTED_THEME_PREFERENCES::contains) ?: "system"
    }
}
