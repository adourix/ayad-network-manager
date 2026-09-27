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
ADMIN_PASSWORD_HASH ?=
ADMIN_PASSWORD_SALT ?=
ADMIN_USERNAME ?= admin
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
  tcpdump-mini \
  sing-box \
  kmod-tun

.PHONY: image check

check:
	@test -n "$(PROFILE)" || (echo "PROFILE is required"; exit 2)
	@test -x "$(IMAGEBUILDER)/make" || (echo "IMAGEBUILDER/make not found"; exit 2)
	@test -n "$(LNCS_IPK)" || (echo "LNCS_IPK must point to the target-built lncs-router-edition package"; exit 2)
	@test -n "$(ADMIN_PASSWORD_HASH)" || (echo "ADMIN_PASSWORD_HASH is required"; exit 2)
	@test -n "$(ADMIN_PASSWORD_SALT)" || (echo "ADMIN_PASSWORD_SALT is required"; exit 2)
	@test -f "$(LNCS_IPK)" || (echo "LNCS_IPK not found: $(LNCS_IPK)"; exit 2)
	@mkdir -p "$(IMAGEBUILDER)/packages"
	@cp "$(LNCS_IPK)" "$(IMAGEBUILDER)/packages/"
	@sed -i "s|^ADMIN_USERNAME=.*|ADMIN_USERNAME=$(ADMIN_USERNAME)|" "$(FILES)/etc/lncs/router.env"
	@sed -i "s|^ADMIN_PASSWORD_HASH=.*|ADMIN_PASSWORD_HASH=$(ADMIN_PASSWORD_HASH)|" "$(FILES)/etc/lncs/router.env"
	@sed -i "s|^ADMIN_PASSWORD_SALT=.*|ADMIN_PASSWORD_SALT=$(ADMIN_PASSWORD_SALT)|" "$(FILES)/etc/lncs/router.env"

image: check
	$(IMAGEBUILDER)/make image PROFILE="$(PROFILE)" PACKAGES="$(PACKAGES)" FILES="$(FILES)"
