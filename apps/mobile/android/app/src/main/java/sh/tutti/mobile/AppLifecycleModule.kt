package sh.tutti.mobile

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.atomic.AtomicInteger

class AppLifecycleModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext),
    DefaultLifecycleObserver {
    private val processLifecycle = ProcessLifecycleOwner.get().lifecycle
    private val listenerCount = AtomicInteger()

    @Volatile
    private var foreground =
        processLifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

    @Volatile
    private var invalidated = false

    init {
        UiThreadUtil.runOnUiThread {
            if (!invalidated) {
                processLifecycle.addObserver(this)
            }
        }
    }

    override fun getName(): String = MODULE_NAME

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun isForeground(): Boolean = foreground

    @ReactMethod
    fun addListener(eventName: String) {
        if (eventName == EVENT_NAME) {
            listenerCount.incrementAndGet()
        }
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        listenerCount.updateAndGet { current -> (current - count).coerceAtLeast(0) }
    }

    override fun onStart(owner: LifecycleOwner) {
        publish(true)
    }

    override fun onStop(owner: LifecycleOwner) {
        publish(false)
    }

    override fun invalidate() {
        invalidated = true
        listenerCount.set(0)
        UiThreadUtil.runOnUiThread {
            processLifecycle.removeObserver(this)
        }
        super.invalidate()
    }

    private fun publish(nextForeground: Boolean) {
        if (foreground == nextForeground) {
            return
        }
        foreground = nextForeground
        if (
            listenerCount.get() == 0 ||
            !reactContext.hasActiveReactInstance()
        ) {
            return
        }
        reactContext
            .getJSModule(
                DeviceEventManagerModule.RCTDeviceEventEmitter::class.java,
            ).emit(EVENT_NAME, nextForeground)
    }

    companion object {
        const val EVENT_NAME = "TuttiAppLifecycleChanged"
        private const val MODULE_NAME = "TuttiAppLifecycle"
    }
}
