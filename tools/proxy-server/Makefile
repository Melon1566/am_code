.DEFAULT_GOAL := help

SUDO ?= sudo
NODE_BIN ?= node
LISTEN ?=
export NODE_BIN LISTEN

.PHONY: help install update start stop restart status logs enable disable run test

help:
	@printf '%s\n' \
	  'make install LISTEN=0.0.0.0  Install, enable at boot, and start on EC2' \
	  'make install                 Install locally; preserve settings on reinstall' \
	  'make update                  Reinstall the checked-out version and restart' \
	  'make start / stop / restart   Control the installed service' \
	  'make status                  Show service status' \
	  'make logs                    Follow service logs (Ctrl-C to exit)' \
	  'make enable / disable        Enable and start / disable and stop the service' \
	  'make run [LISTEN=address]     Run in the foreground without installing' \
	  'make test                    Run local socket tests'

install:
	@if [ -n "$$LISTEN" ]; then \
	  $(SUDO) ./install.sh "$$LISTEN"; \
	else \
	  $(SUDO) ./install.sh; \
	fi

update: install

start:
	$(SUDO) systemctl start t3-proxy-server

stop:
	$(SUDO) systemctl stop t3-proxy-server

restart:
	$(SUDO) systemctl restart t3-proxy-server

status:
	$(SUDO) systemctl --no-pager --full status t3-proxy-server

logs:
	$(SUDO) journalctl -u t3-proxy-server -f

enable:
	$(SUDO) systemctl enable --now t3-proxy-server

disable:
	$(SUDO) systemctl disable --now t3-proxy-server

run:
	@if [ -n "$$LISTEN" ]; then export T3_PROXY_HOST="$$LISTEN"; fi; \
	./start.sh

test:
	"$$NODE_BIN" --test server.test.ts
