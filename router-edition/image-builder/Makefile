# LNCS Router Edition image assembly.
# This is intentionally an ImageBuilder wrapper, not an install script.
#
# Usage:
#   make image IMAGEBUILDER=/path/to/openwrt-imagebuilder PROFILE=<target-profile>
#
# The selected ImageBuilder must match the exact OpenWrt release/target of the
# router. The LNCS runtime package/artifacts must be available to ImageBuilder.

IMAGEBUILDER ?= ./openwrt-imagebuilder
PROFILE ?=
LNCS_IPK ?=
FILES := $(CURDIR)/files

PACKAGES := \
  lncs-router-edition \
  node \
  nftables \
  nftables-json \
  tc-full \
  ip-full \
  kmod-ifb \
  kmod-sched-core \
  kmod-sched-flower \
  dnsmasq \
  procd-ujail \
  libsqlite3-0 \
  sqlite3-cli \
  tcpdump-mini

.PHONY: image check

check:
	@test -n "$(PROFILE)" || (echo "PROFILE is required"; exit 2)
	@test -x "$(IMAGEBUILDER)/make" || (echo "IMAGEBUILDER/make not found"; exit 2)
	@test -n "$(LNCS_IPK)" || (echo "LNCS_IPK must point to the target-built lncs-router-edition package"; exit 2)
	@test -f "$(LNCS_IPK)" || (echo "LNCS_IPK not found: $(LNCS_IPK)"; exit 2)
	@mkdir -p "$(IMAGEBUILDER)/packages"
	@cp "$(LNCS_IPK)" "$(IMAGEBUILDER)/packages/"

image: check
	$(IMAGEBUILDER)/make image PROFILE="$(PROFILE)" PACKAGES="$(PACKAGES)" FILES="$(FILES)"
