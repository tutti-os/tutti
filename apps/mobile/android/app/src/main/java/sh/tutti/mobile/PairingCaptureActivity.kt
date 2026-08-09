package sh.tutti.mobile

import android.app.Activity
import android.content.Intent
import android.view.View
import android.widget.Button
import com.journeyapps.barcodescanner.CaptureActivity
import com.journeyapps.barcodescanner.DecoratedBarcodeView

class PairingCaptureActivity : CaptureActivity() {
    override fun initializeContent(): DecoratedBarcodeView {
        setContentView(R.layout.activity_pairing_capture)
        findViewById<Button>(R.id.pairing_manual_button).setOnClickListener {
            setResult(
                Activity.RESULT_CANCELED,
                Intent().putExtra(EXTRA_MANUAL_PAIRING, true),
            )
            finish()
        }
        return findViewById<DecoratedBarcodeView>(R.id.zxing_barcode_scanner).also {
            it.statusView.visibility = View.GONE
        }
    }

    companion object {
        const val EXTRA_MANUAL_PAIRING = "tutti_manual_pairing"
    }
}
