.PHONY: test android-crosscompile android-bindings-check android-aar android-aar-check android-probe-apk

ANDROID_API ?= 26
ANDROID_NDK_VERSION ?= 27.3.13750724
ANDROID_BUILD_TOOLS_VERSION ?= 36.0.0
AAR_OUTPUT ?= dist/tutti-device-link.aar
PROBE_APK_OUTPUT ?= dist/tutti-device-link-probe.apk
PROBE_KEYSTORE ?= dist/tutti-device-link-probe-debug.keystore
GOMOBILE_LDFLAGS ?= -checklinkname=0

test:
	go test ./...

android-crosscompile:
	GOOS=android GOARCH=arm64 CGO_ENABLED=0 go build ./...

android-bindings-check:
	@bind_tmp=$$(mktemp -d); \
	trap 'rm -rf "$$bind_tmp"' EXIT; \
	go tool gobind -lang=java -javapkg=dev.tutti.devicelink -outdir="$$bind_tmp" ./mobile; \
	test -f "$$bind_tmp/java/dev/tutti/devicelink/mobile/Mobile.java"

android-aar:
	@test -n "$(ANDROID_HOME)" || (echo "ANDROID_HOME is required" >&2; exit 1)
	@test -n "$(JAVA_HOME)" || (echo "JAVA_HOME is required" >&2; exit 1)
	@test -x "$(JAVA_HOME)/bin/javac" || (echo "JAVA_HOME does not contain javac" >&2; exit 1)
	@test -f "$(ANDROID_HOME)/ndk/$(ANDROID_NDK_VERSION)/source.properties" || (echo "Android NDK $(ANDROID_NDK_VERSION) is required" >&2; exit 1)
	@mkdir -p "$(dir $(AAR_OUTPUT))"
	@tool_tmp=$$(mktemp -d); \
	trap 'rm -rf "$$tool_tmp"' EXIT; \
	GOBIN="$$tool_tmp" go install golang.org/x/mobile/cmd/gobind; \
	ANDROID_NDK_HOME="$(ANDROID_HOME)/ndk/$(ANDROID_NDK_VERSION)" PATH="$$tool_tmp:$$PATH" go tool gomobile bind -target=android -androidapi=$(ANDROID_API) -javapkg=dev.tutti.devicelink -ldflags="$(GOMOBILE_LDFLAGS)" -o "$(AAR_OUTPUT)" ./mobile
	@$(MAKE) android-aar-check

android-aar-check:
	@test -n "$(JAVA_HOME)" || (echo "JAVA_HOME is required" >&2; exit 1)
	@test -f "$(AAR_OUTPUT)" || (echo "AAR not found: $(AAR_OUTPUT)" >&2; exit 1)
	@unzip -tq "$(AAR_OUTPUT)" >/dev/null
	@for abi in armeabi-v7a arm64-v8a x86 x86_64; do \
		unzip -Z1 "$(AAR_OUTPUT)" | grep -Fqx "jni/$$abi/libgojni.so" || exit 1; \
	done
	@aar_tmp=$$(mktemp -d); \
	trap 'rm -rf "$$aar_tmp"' EXIT; \
	unzip -p "$(AAR_OUTPUT)" classes.jar > "$$aar_tmp/classes.jar"; \
	"$(JAVA_HOME)/bin/jar" tf "$$aar_tmp/classes.jar" | grep -Fqx 'dev/tutti/devicelink/mobile/Mobile.class'

android-probe-apk: android-aar-check
	@test -n "$(ANDROID_HOME)" || (echo "ANDROID_HOME is required" >&2; exit 1)
	@test -x "$(JAVA_HOME)/bin/javac" || (echo "JAVA_HOME does not contain javac" >&2; exit 1)
	@mkdir -p "$(dir $(PROBE_APK_OUTPUT))" "$(dir $(PROBE_KEYSTORE))"
	@test -f "$(PROBE_KEYSTORE)" || "$(JAVA_HOME)/bin/keytool" -genkeypair -keystore "$(PROBE_KEYSTORE)" -storepass android -keypass android -alias androiddebugkey -dname 'CN=Android Debug,O=Android,C=US' -keyalg RSA -validity 10000 >/dev/null 2>&1
	@probe_tmp=$$(mktemp -d); \
	set -e; \
	trap 'rm -rf "$$probe_tmp"' EXIT; \
	build_tools="$(ANDROID_HOME)/build-tools/$(ANDROID_BUILD_TOOLS_VERSION)"; \
	android_jar="$(ANDROID_HOME)/platforms/android-36/android.jar"; \
	test -x "$$build_tools/d8"; \
	test -x "$$build_tools/aapt2"; \
	test -x "$$build_tools/zipalign"; \
	test -x "$$build_tools/apksigner"; \
	test -f "$$android_jar"; \
	mkdir -p "$$probe_tmp/classes" "$$probe_tmp/dex" "$$probe_tmp/apk/lib/arm64-v8a"; \
	unzip -p "$(AAR_OUTPUT)" classes.jar > "$$probe_tmp/device-link-classes.jar"; \
	unzip -p "$(AAR_OUTPUT)" jni/arm64-v8a/libgojni.so > "$$probe_tmp/apk/lib/arm64-v8a/libgojni.so"; \
	"$(JAVA_HOME)/bin/javac" -source 8 -target 8 -bootclasspath "$$android_jar" -classpath "$$probe_tmp/device-link-classes.jar" -d "$$probe_tmp/classes" mobile/androidprobe/src/dev/tutti/devicelink/probe/ProbeActivity.java; \
	"$(JAVA_HOME)/bin/jar" cf "$$probe_tmp/probe-classes.jar" -C "$$probe_tmp/classes" .; \
	JAVA_HOME="$(JAVA_HOME)" "$$build_tools/d8" --lib "$$android_jar" --output "$$probe_tmp/dex" "$$probe_tmp/probe-classes.jar" "$$probe_tmp/device-link-classes.jar"; \
	"$$build_tools/aapt2" link -o "$$probe_tmp/unsigned.apk" -I "$$android_jar" --manifest mobile/androidprobe/AndroidManifest.xml --min-sdk-version 26 --target-sdk-version 35; \
	(cd "$$probe_tmp/dex" && zip -q "$$probe_tmp/unsigned.apk" classes.dex); \
	(cd "$$probe_tmp/apk" && zip -q -r "$$probe_tmp/unsigned.apk" lib); \
	"$$build_tools/zipalign" -p -f 4 "$$probe_tmp/unsigned.apk" "$$probe_tmp/aligned.apk"; \
	"$$build_tools/apksigner" sign --ks "$(PROBE_KEYSTORE)" --ks-pass pass:android --key-pass pass:android --out "$(PROBE_APK_OUTPUT)" "$$probe_tmp/aligned.apk"; \
	"$$build_tools/apksigner" verify "$(PROBE_APK_OUTPUT)"
