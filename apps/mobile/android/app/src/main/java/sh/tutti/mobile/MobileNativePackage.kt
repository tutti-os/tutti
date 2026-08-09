package sh.tutti.mobile

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class MobileNativePackage : ReactPackage {
    override fun createNativeModules(
        reactContext: ReactApplicationContext,
    ): List<NativeModule> =
        listOf(
            AppLifecycleModule(reactContext),
            MobilePreferencesModule(reactContext),
            MobileSecurityModule(reactContext),
            DeviceLinkModule(reactContext),
        )

    override fun createViewManagers(
        reactContext: ReactApplicationContext,
    ): List<ViewManager<*, *>> = emptyList()
}
