# Local macOS helpers for this fork. Upstream build docs live in
# docs/operations/development.md; this file wraps the packaged-app rebuild and
# the provider proxy tunnel so neither needs its flags remembered.
#
#   make app             rebuild release/T3 Code (Alpha).app from the current tree
#   make open            launch the built app (quit the installed T3 Code first)
#   make run             app + open
#   make sign            re-sign the built app with a local Apple identity
#   make snapshot        back up ~/.t3/userdata/state.sqlite before a risky upgrade
#   make clean           remove build artifacts in release/
#   make proxy           check the provider proxy tunnel end to end
#   make proxy-restart   reconnect the tunnel now
#   make proxy-stop      stop the tunnel until you log in again
#   make proxy-shell     open a shell on the proxy instance over SSM

SHELL := /bin/bash
ARCH ?= arm64

# The repo needs Node 24+; the shell default here is an older nvm install.
# Recipes call node by absolute path: GNU make execs simple commands with its
# own PATH, so the export below only reaches programs the build spawns.
NODE_BIN ?= /opt/homebrew/opt/node/bin
export PATH := $(NODE_BIN):$(CURDIR)/node_modules/.bin:$(PATH)

# Apple signing credentials are CI-only secrets, so a local build is ad-hoc
# signed. Endpoint security tools read an unsigned process that walks the
# process table (the resource monitor) and then reaches the network as an
# attack and kill it, so re-sign with whatever Apple identity is on this
# machine. Override with SIGN_IDENTITY to pick a specific one.
SIGN_IDENTITY ?= $(shell security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -1)

APP_NAME := T3 Code (Alpha).app
APP := release/$(APP_NAME)

# Codex and Claude reach their endpoints through a proxy on an EC2 box, over an
# SSM port forward that two launchd agents keep up. SSM addresses the instance
# by id, so neither its public IP nor this machine's egress IP appears here.
# The server side lives in tools/proxy-server; these targets only drive the
# local end. A successful /healthz proves the whole chain, not just the socket.
PROXY_INSTANCE ?= i-0fc83454343129a90
PROXY_PORT ?= 3128
PROXY_AGENTS := com.t3.proxy-tunnel com.t3.proxy-keepalive
LAUNCHD_DOMAIN := gui/$(shell id -u)

.PHONY: help app open run sign snapshot clean proxy proxy-restart proxy-stop proxy-shell

help:
	@sed -n '5,14p' $(MAKEFILE_LIST) | sed 's/^#   //'

app: node_modules .env
	$(NODE_BIN)/node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch $(ARCH)
	rm -rf "$(APP)"
	cd release && unzip -q -o "$$(ls -t T3-Code-*-$(ARCH).zip | head -1)"
	@xattr -dr com.apple.quarantine "$(APP)" 2>/dev/null || true
	@$(MAKE) --no-print-directory sign
	@echo "Built $(APP)"

open:
	@if ps -axo comm= | grep -qF "$(APP_NAME)/Contents/MacOS/"; then \
		echo "T3 Code is already running. Quit it first so only one server opens ~/.t3/userdata."; \
		exit 1; \
	fi
	open "$(APP)"

run: app open

# codesign --deep skips Mach-O files outside the nested-code locations it knows
# about, which is where the resource monitor and the unpacked node addons live.
# Signing every binary deepest-first covers them, then --deep reseals the
# bundles over the results. Hardened runtime stays off: it would require the
# full Electron entitlement set and buys nothing for a local run.
sign:
	@if [ -z "$(SIGN_IDENTITY)" ]; then \
		echo "No Apple Development identity in the keychain; leaving $(APP) ad-hoc signed."; \
		exit 0; \
	fi; \
	if [ ! -d "$(APP)" ]; then \
		echo "No app at $(APP). Run make app first."; \
		exit 1; \
	fi; \
	echo "Signing $(APP) as $(SIGN_IDENTITY)"; \
	find "$(APP)" -type f | while IFS= read -r candidate; do \
		file -b "$$candidate" | grep -q Mach-O || continue; \
		printf '%s\t%s\n' "$$(printf '%s' "$$candidate" | tr -cd / | wc -c)" "$$candidate"; \
	done | sort -rn | cut -f2- | while IFS= read -r binary; do \
		codesign --force --sign "$(SIGN_IDENTITY)" "$$binary" >/dev/null 2>&1 \
			|| echo "warning: could not sign $$binary"; \
	done; \
	codesign --force --deep --sign "$(SIGN_IDENTITY)" "$(APP)" >/dev/null; \
	codesign --verify --deep --strict "$(APP)" && echo "Signed $(APP)"

proxy:
	@printf '%-12s' 'health:'; \
	curl -sf --max-time 10 http://127.0.0.1:$(PROXY_PORT)/healthz >/dev/null \
		&& echo 'ok (proxy reachable on localhost:$(PROXY_PORT))' \
		|| echo 'DOWN'
	@printf '%-12s' 'tunnel:'; \
	launchctl print $(LAUNCHD_DOMAIN)/com.t3.proxy-tunnel 2>/dev/null \
		| sed -n 's/^[[:space:]]*state = //p' | head -1 | grep . || echo 'not loaded'
	@# The keepalive fires on an interval, so it is idle between runs by design;
	@# only whether it is scheduled tells you anything.
	@printf '%-12s' 'keepalive:'; \
	launchctl print $(LAUNCHD_DOMAIN)/com.t3.proxy-keepalive >/dev/null 2>&1 \
		&& echo 'scheduled' || echo 'not loaded'
	@printf '%-12s' 'instance:'; \
	aws ssm describe-instance-information --filters 'Key=InstanceIds,Values=$(PROXY_INSTANCE)' \
		--query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || echo 'unknown'

proxy-stop:
	@for agent in $(PROXY_AGENTS); do \
		launchctl bootout $(LAUNCHD_DOMAIN)/$$agent 2>/dev/null || true; \
	done; \
	echo 'Tunnel stopped. It returns at next login, or with make proxy-restart.'

# Session Manager needs a moment to open the forward before a health check means
# anything, so report status only after it has had time to connect.
proxy-restart: proxy-stop
	@for agent in $(PROXY_AGENTS); do \
		launchctl bootstrap $(LAUNCHD_DOMAIN) "$(HOME)/Library/LaunchAgents/$$agent.plist"; \
	done
	@sleep 15
	@$(MAKE) --no-print-directory proxy

# The AWS CLI shells out to session-manager-plugin by name, and it is installed
# under ~/.local/bin rather than a system path.
proxy-shell:
	@PATH="$(HOME)/.local/bin:$$PATH" aws ssm start-session --target $(PROXY_INSTANCE)

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
