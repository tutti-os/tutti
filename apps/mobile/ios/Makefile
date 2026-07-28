.PHONY: ios-bindings-check ios-framework ios-framework-check

GOMOBILE_GO_TOOLCHAIN ?= go1.26.0
GOMOBILE_LDFLAGS ?= -checklinkname=0
REPO_ROOT := $(abspath ../../..)
DEVICE_LINK_DIR := $(REPO_ROOT)/packages/device-link
FRAMEWORK_OUTPUT ?= $(CURDIR)/Frameworks/TuttiMobileGo.xcframework
OBJC_PREFIX := TUT
GOMOBILE_GO := env GOTOOLCHAIN=$(GOMOBILE_GO_TOOLCHAIN) go

ios-bindings-check:
	@bind_tmp=$$(mktemp -d); \
	trap 'rm -rf "$$bind_tmp"' EXIT; \
	cd "$(DEVICE_LINK_DIR)" && DEVELOPER_DIR=/Library/Developer/CommandLineTools $(GOMOBILE_GO) tool gobind -lang=objc -prefix=$(OBJC_PREFIX) -outdir="$$bind_tmp" ./mobile ../agent/daemon/liveprotocol/mobile; \
	test -f "$$bind_tmp/src/gobind/$(OBJC_PREFIX)Mobile.objc.h"; \
	test -f "$$bind_tmp/src/gobind/$(OBJC_PREFIX)Liveprotocolmobile.objc.h"; \
	grep -Fq 'TUTMobileNewLink' "$$bind_tmp/src/gobind/$(OBJC_PREFIX)Mobile.objc.h"; \
	grep -Fq 'TUTLiveprotocolmobileNewSubscriber' "$$bind_tmp/src/gobind/$(OBJC_PREFIX)Liveprotocolmobile.objc.h"

ios-framework:
	@xcode_path=$$(xcode-select -p 2>/dev/null); \
	test -n "$$xcode_path" && test -d "$$xcode_path/Platforms/iPhoneOS.platform" || (echo "Full Xcode with the iOS SDK is required" >&2; exit 1)
	@mkdir -p "$(dir $(FRAMEWORK_OUTPUT))"
	@tool_tmp=$$(mktemp -d); \
	trap 'rm -rf "$$tool_tmp"' EXIT; \
	cd "$(DEVICE_LINK_DIR)" && GOBIN="$$tool_tmp" $(GOMOBILE_GO) install golang.org/x/mobile/cmd/gobind; \
	cd "$(DEVICE_LINK_DIR)" && PATH="$$tool_tmp:$$PATH" $(GOMOBILE_GO) tool gomobile bind -target=ios,iossimulator -prefix=$(OBJC_PREFIX) -ldflags="$(GOMOBILE_LDFLAGS)" -o "$(FRAMEWORK_OUTPUT)" ./mobile ../agent/daemon/liveprotocol/mobile
	@$(MAKE) ios-framework-check

ios-framework-check:
	@test -d "$(FRAMEWORK_OUTPUT)" || (echo "XCFramework not found: $(FRAMEWORK_OUTPUT)" >&2; exit 1)
	@test -f "$(FRAMEWORK_OUTPUT)/Info.plist"
	@find "$(FRAMEWORK_OUTPUT)" -path '*/Headers/TUTMobile.objc.h' -print -quit | grep -q .
	@find "$(FRAMEWORK_OUTPUT)" -path '*/Headers/TUTLiveprotocolmobile.objc.h' -print -quit | grep -q .
