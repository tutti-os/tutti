package sh.tutti.mobile

import java.net.URL
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileUpdateDownloaderTest {
    @Test
    fun `accepts HTTPS update URLs`() {
        assertTrue(isHTTPSUpdateURL(URL("https://updates.example.test/app.apk")))
    }

    @Test
    fun `rejects HTTP update URLs`() {
        assertFalse(isHTTPSUpdateURL(URL("http://updates.example.test/app.apk")))
    }
}
