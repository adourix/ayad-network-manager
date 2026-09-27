include $(TOPDIR)/rules.mk

PKG_NAME:=lncs-router-edition
PKG_VERSION:=0.2.0
PKG_RELEASE:=1
PKGARCH:=all

include $(INCLUDE_DIR)/package.mk

# Point this at a target-built runtime bundle. It must contain:
#   backend/dist/
#   backend/node_modules/
#   frontend/dist/
#   backend/prisma/migrations/
#   backend/prisma/schema.prisma
LNCS_RUNTIME_DIR ?= $(TOPDIR)/../lncs-router-runtime

define Package/lncs-router-edition
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Linux Network Control System Router Edition
  DEPENDS:=+node +nftables +nftables-json +tc-full +ip-full +kmod-ifb +kmod-sched-core +kmod-sched-flower +dnsmasq +procd-ujail +libsqlite3-0 +tcpdump-mini +sing-box +kmod-tun
endef

define Package/lncs-router-edition/description
Boot-time OpenWrt Router Edition of Linux Network Control System.
No installer is used; the package is intended to be baked into an OpenWrt image.
endef

define Build/Configure
endef

define Build/Compile
	@test -d "$(LNCS_RUNTIME_DIR)/backend/dist" || (echo "Missing $(LNCS_RUNTIME_DIR)/backend/dist"; exit 2)
	@test -d "$(LNCS_RUNTIME_DIR)/backend/node_modules" || (echo "Missing target-built backend/node_modules"; exit 2)
	@test -d "$(LNCS_RUNTIME_DIR)/frontend/dist" || (echo "Missing $(LNCS_RUNTIME_DIR)/frontend/dist"; exit 2)
endef

define Package/lncs-router-edition/install
	$(INSTALL_DIR) $(1)/usr/lib/lncs/backend
	$(INSTALL_DIR) $(1)/usr/lib/lncs/database
	$(INSTALL_DIR) $(1)/usr/lib/lncs/frontend
	$(INSTALL_DIR) $(1)/etc/lncs
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_DIR) $(1)/etc/capabilities

	$(CP) $(LNCS_RUNTIME_DIR)/backend/dist $(1)/usr/lib/lncs/backend/
	$(CP) $(LNCS_RUNTIME_DIR)/backend/node_modules $(1)/usr/lib/lncs/backend/
	$(CP) $(LNCS_RUNTIME_DIR)/frontend/dist $(1)/usr/lib/lncs/frontend/
	$(CP) $(LNCS_RUNTIME_DIR)/backend/prisma $(1)/usr/lib/lncs/backend/
	$(INSTALL_DATA) ./../router.env.example $(1)/etc/lncs/router.env
	$(INSTALL_BIN) ./files/lncs-enforcement.init $(1)/etc/init.d/lncs-enforcement
	$(INSTALL_BIN) ./../procd-init/lncs-db-init.init $(1)/etc/init.d/lncs-db-init
	$(INSTALL_DATA) ./../database/init.sql $(1)/usr/lib/lncs/database/init.sql
	$(INSTALL_BIN) ./files/lncs-backend.init $(1)/etc/init.d/lncs-backend
	$(INSTALL_DATA) ./../procd-init/lncs-enforcement.capabilities.json $(1)/etc/capabilities/lncs-enforcement.json
endef

$(eval $(call BuildPackage,lncs-router-edition))
