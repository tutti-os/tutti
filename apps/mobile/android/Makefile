.PHONY: android-bindings-check android-aar android-aar-check

ANDROID_API ?= 26
ANDROID_NDK_VERSION ?= 27.3.13750724
GOMOBILE_GO_TOOLCHAIN ?= go1.26.0
GOMOBILE_LDFLAGS ?= -checklinkname=0
REPO_ROOT := $(abspath ../../..)
DEVICE_LINK_DIR := $(REPO_ROOT)/packages/device-link
AAR_OUTPUT ?= $(CURDIR)/app/libs/tutti-mobile-go.aar
JAVA_PACKAGE := dev.tutti.mobile.bindings
GOMOBILE_GO := env GOTOOLCHAIN=$(GOMOBILE_GO_TOOLCHAIN) go

android-bindings-check:
	@bind_tmp=$$(mktemp -d); \
	trap 'rm -rf "$$bind_tmp"' EXIT; \
	cd "$(DEVICE_LINK_DIR)" && $(GOMOBILE_GO) tool gobind -lang=java -javapkg=$(JAVA_PACKAGE) -outdir="$$bind_tmp" ./mobile ../agent/daemon/liveprotocol/mobile; \
	test -f "$$bind_tmp/java/dev/tutti/mobile/bindings/mobile/Mobile.java"; \
	test -f "$$bind_tmp/java/dev/tutti/mobile/bindings/liveprotocolmobile/Liveprotocolmobile.java"

android-aar:
	@test -n "$(ANDROID_HOME)" || (echo "ANDROID_HOME is required" >&2; exit 1)
	@test -n "$(JAVA_HOME)" || (echo "JAVA_HOME is required" >&2; exit 1)
	@test -x "$(JAVA_HOME)/bin/javac" || (echo "JAVA_HOME does not contain javac" >&2; exit 1)
	@test -f "$(ANDROID_HOME)/ndk/$(ANDROID_NDK_VERSION)/source.properties" || (echo "Android NDK $(ANDROID_NDK_VERSION) is required" >&2; exit 1)
	@mkdir -p "$(dir $(AAR_OUTPUT))"
	@tool_tmp=$$(mktemp -d); \
	trap 'rm -rf "$$tool_tmp"' EXIT; \
	cd "$(DEVICE_LINK_DIR)" && GOBIN="$$tool_tmp" $(GOMOBILE_GO) install golang.org/x/mobile/cmd/gobind; \
	cd "$(DEVICE_LINK_DIR)" && ANDROID_NDK_HOME="$(ANDROID_HOME)/ndk/$(ANDROID_NDK_VERSION)" PATH="$$tool_tmp:$$PATH" $(GOMOBILE_GO) tool gomobile bind -target=android -androidapi=$(ANDROID_API) -javapkg=$(JAVA_PACKAGE) -ldflags="$(GOMOBILE_LDFLAGS)" -o "$(AAR_OUTPUT)" ./mobile ../agent/daemon/liveprotocol/mobile
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
	"$(JAVA_HOME)/bin/jar" tf "$$aar_tmp/classes.jar" | grep -Fqx 'dev/tutti/mobile/bindings/mobile/Mobile.class'; \
	"$(JAVA_HOME)/bin/jar" tf "$$aar_tmp/classes.jar" | grep -Fqx 'dev/tutti/mobile/bindings/liveprotocolmobile/Liveprotocolmobile.class'; \
	for abi in armeabi-v7a arm64-v8a x86 x86_64; do \
		unzip -p "$(AAR_OUTPUT)" "jni/$$abi/libgojni.so" > "$$aar_tmp/libgojni-$$abi.so"; \
		$(GOMOBILE_GO) version -m "$$aar_tmp/libgojni-$$abi.so" | head -n 1 | grep -Fq ": $(GOMOBILE_GO_TOOLCHAIN)"; \
	done
