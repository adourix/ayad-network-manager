# LNCS Router Edition — OpenWrt

هذه شجرة Router Edition منفصلة عن main. الـcore Debian/Ubuntu deployment لا يتغير.

## ما تم تحويله

- PostgreSQL/Prisma runtime -> SQLite/Prisma adapter.
- systemd/setup wizard -> OpenWrt procd.
- DHCP leases -> /tmp/dhcp.leases.
- LAN/WAN authority -> UCI/netifd.
- firewall enforcement -> inet fw4 مع chains/sets خاصة بـLNCS.
- NAT -> inet fw4 / srcnat.
- traffic shaping -> نفس single-interface-IFB التصميم، مع tc-full وIFB/flower.
- frontend -> Fastify مباشرة بدون nginx/uhttpd.
- SQLite DB -> /etc/lncs/lncs.db، مع schema initialization عند boot.
- privileged enforcement process -> procd + capability profile لـCAP_NET_ADMIN وCAP_NET_RAW.

## لا يوجد installer

Router Edition لا تحتوي ولا تستخدم install.sh. طريقة التوزيع المقصودة:

1. اختيار OpenWrt release/target/device profile الصحيح.
2. بناء runtime bundle متوافق مع CPU/ABI/musl.
3. بناء lncs-router-edition package.
4. دمج package + overlay داخل OpenWrt ImageBuilder.
5. إنتاج firmware image.
6. حرق/flash الصورة على الراوتر.

بعد الإقلاع لا يوجد LNCS installation wizard. OpenWrt/LuCI مسؤول عن WAN/LAN/Wi-Fi، وLNCS يقرأ UCI ويبدأ control plane مباشرة.

### حساب الإدارة عند أول تشغيل

الصورة تُنشئ تلقائيًا حساب الإدارة `admin` بكلمة المرور `admin`. عند أول تسجيل دخول تُجبر الواجهة المستخدم على تغيير كلمة المرور من Settings. بعد تغييرها لا تبقى كلمة المرور الافتراضية صالحة، ويتم حفظ كلمة المرور الجديدة كـscrypt hash داخل SQLite.

## أهم المسارات

- backend/src/config.ts — اشتقاق LAN/WAN/subnet من UCI.
- backend/src/server.ts — Router control plane.
- backend/src/infrastructure/database/prisma.ts — SQLite adapter.
- backend/src/infrastructure/network/OpenWrtDhcpLeaseReader.ts.
- backend/src/infrastructure/network/OpenWrtDnsmasqReloader.ts.
- backend/src/infrastructure/enforcement/NftEnforcer.ts — fw4 integration.
- backend/src/infrastructure/enforcement/EnforcementAgent.ts — privileged boundary.
- router-edition/database/init.sql — SQLite schema.
- router-edition/procd-init/ — boot services.
- router-edition/image-builder/ — firmware assembly.
- router-edition/opkg-package/ — target package.

## الحالة الحالية

الكود أصبح Router-oriented بدل scaffold، لكن لم يتم إعلان hardware validation بعد.
أول target فعلي يجب أن يثبت:

- Node 22 على نفس architecture/libc.
- SQLite adapter/native dependency على نفس target.
- Prisma Client queries على DB حقيقية.
- fw4 reload بدون فقدان state بعد reconciliation.
- IFB + flower + mirred + HTB بمرور traffic حقيقي.
- procd respawn/reload.
- reboot persistence.
- flash -> boot -> configure UCI -> enforce end-to-end.

لا نعتبر TypeScript/build على جهاز التطوير دليلًا على دعم router معيّن.
