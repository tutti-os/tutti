package sh.tutti.mobile

import android.net.Uri
import android.os.Bundle
import androidx.browser.auth.AuthTabIntent
import androidx.browser.customtabs.CustomTabsClient
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.swmansion.rnscreens.fragment.restoration.RNScreensFragmentFactory

class MainActivity : ReactActivity() {
    private var authTabResultHandler: ((AuthTabIntent.AuthResult) -> Unit)? = null
    private val authTabLauncher =
        registerForActivityResult(
            AuthTabIntent.AuthenticateUserResultContract(),
        ) { result ->
            val handler = authTabResultHandler
            authTabResultHandler = null
            handler?.invoke(result)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        supportFragmentManager.fragmentFactory = RNScreensFragmentFactory()
        super.onCreate(savedInstanceState)
    }

    override fun getMainComponentName(): String = "TuttiMobile"

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

    fun launchBrowserAuthentication(
        loginURL: Uri,
        callbackScheme: String,
        onResult: (AuthTabIntent.AuthResult) -> Unit,
    ): Boolean {
        val provider = CustomTabsClient.getPackageName(this, null) ?: return false
        if (!CustomTabsClient.isAuthTabSupported(this, provider)) {
            return false
        }
        check(authTabResultHandler == null) {
            "A browser authentication tab is already active"
        }
        authTabResultHandler = onResult
        return try {
            AuthTabIntent.Builder().build().launch(
                authTabLauncher,
                loginURL,
                callbackScheme,
            )
            true
        } catch (cause: Exception) {
            authTabResultHandler = null
            throw cause
        }
    }
}
