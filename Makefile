# Local macOS build helpers for this fork. Upstream build docs live in
# docs/operations/development.md; this file only wraps them so the packaged
# app can be rebuilt and launched from release/ without remembering flags.
#
#   make app       rebuild release/T3 Code (Alpha).app from the current tree
#   make open      launch the built app (quit the installed T3 Code first)
#   make run       app + open
#   make snapshot  back up ~/.t3/userdata/state.sqlite before a risky upgrade
#   make clean     remove build artifacts in release/

SHELL := /bin/bash
ARCH ?= arm64
RUST_TARGET := aarch64-apple-darwin

# The repo needs Node 24+; the shell default here is an older nvm install.
# Recipes call node by absolute path: GNU make execs simple commands with its
# own PATH, so the export below only reaches programs the build spawns.
NODE_BIN ?= /opt/homebrew/opt/node/bin
export PATH := $(NODE_BIN):$(CURDIR)/node_modules/.bin:$(PATH)
# Rust is not installed, so the resource-monitor helper is borrowed from the
# installed release build instead of compiled. Set to 0 to compile it.
export T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR ?= 1

APP_NAME := T3 Code (Alpha).app
APP := release/$(APP_NAME)
INSTALLED_APP := /Applications/$(APP_NAME)
MONITOR_SRC := $(INSTALLED_APP)/Contents/Resources/resource-monitor/t3-resource-monitor
MONITOR_DST := native/resource-monitor/target/$(RUST_TARGET)/release/t3-resource-monitor

.PHONY: help app open run monitor snapshot clean

help:
	@sed -n '5,9p' $(MAKEFILE_LIST) | sed 's/^#   //'

app: monitor node_modules .env
	$(NODE_BIN)/node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch $(ARCH)
	rm -rf "$(APP)"
	cd release && unzip -q -o "$$(ls -t T3-Code-*-$(ARCH).zip | head -1)"
	@xattr -dr com.apple.quarantine "$(APP)" 2>/dev/null || true
	@echo "Built $(APP)"

open:
	@if ps -axo comm= | grep -qF "$(APP_NAME)/Contents/MacOS/"; then \
		echo "T3 Code is already running. Quit it first so only one server opens ~/.t3/userdata."; \
		exit 1; \
	fi
	open "$(APP)"

run: app open

# Stage the prebuilt helper only when reuse is on and nothing is staged yet.
monitor:
	@if [ "$(T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR)" = "1" ] && [ ! -f "$(MONITOR_DST)" ]; then \
		if [ ! -f "$(MONITOR_SRC)" ]; then \
			echo "No resource monitor to reuse at $(MONITOR_SRC). Install Rust or set T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=0."; \
			exit 1; \
		fi; \
		mkdir -p "$(dir $(MONITOR_DST))"; \
		cp "$(MONITOR_SRC)" "$(MONITOR_DST)"; \
		chmod +x "$(MONITOR_DST)"; \
	fi

node_modules:
	$(NODE_BIN)/npx -y pnpm@11.10.0 install
	git checkout -- pnpm-lock.yaml

.env:
	cp .env.example .env

# VACUUM INTO is safe while the app has the database open.
snapshot:
	mkdir -p ~/.t3/backups
	bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.t3/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '\" + process.env.HOME + \"/.t3/backups/state-$$(date +%Y%m%d-%H%M%S).sqlite'\")"
	@ls -t ~/.t3/backups | head -1

clean:
	rm -rf release
