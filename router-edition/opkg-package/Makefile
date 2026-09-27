include $(TOPDIR)/rules.mk

PKG_NAME:=lncs-router-edition
PKG_RELEASE:=1

include $(INCLUDE_DIR)/package.mk

define Package/lncs-router-edition
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Linux Network Control System Router Edition
  DEPENDS:=+node +nftables +tc-tiny +ip-full +dnsmasq
endef

define Package/lncs-router-edition/description
OpenWrt deployment package for Ayad Network Manager / LNCS.
endef

define Build/Compile
endef

define Package/lncs-router-edition/install
	$(INSTALL_DIR) $(1)/usr/lib/lncs
	$(INSTALL_DIR) $(1)/etc/lncs
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/lncs-enforcement.init $(1)/etc/init.d/lncs-enforcement
	$(INSTALL_BIN) ./files/lncs-backend.init $(1)/etc/init.d/lncs-backend
endef

$(eval $(call BuildPackage,lncs-router-edition))
