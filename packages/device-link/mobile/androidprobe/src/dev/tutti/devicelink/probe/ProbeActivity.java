package dev.tutti.devicelink.probe;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;

import dev.tutti.devicelink.mobile.Mobile;

public final class ProbeActivity extends Activity {
  public static final String LOG_TAG = "TuttiDeviceLinkProbe";

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    Thread probeThread =
        new Thread(
            new Runnable() {
              @Override
              public void run() {
                try {
                  long epoch = Mobile.probeEpoch();
                  String echo = Mobile.runLoopbackProbe(30_000L);
                  Log.i(LOG_TAG, "PASS epoch=" + epoch + " echo=" + echo);
                } catch (Throwable error) {
                  Log.e(LOG_TAG, "FAIL", error);
                } finally {
                  finish();
                }
              }
            },
            "tutti-device-link-probe");
    probeThread.start();
  }
}
