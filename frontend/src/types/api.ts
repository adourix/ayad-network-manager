export interface Device { id:number; ip:string|null; mac:string; hostname:string|null; online:boolean; identitySource:string; identityValidated:boolean; l2Visible:boolean; blocked:boolean; appliedQuota:string|null; quotaPeriod:string|null; quotaAction:string|null; firstSeen:string; lastSeen:string; }
export interface Policy { blocked:boolean; downloadLimit:string|null; uploadLimit:string|null; quota:string|null; quotaPeriod:string|null; quotaAction:string|null; }
export interface Quota { quota:string|null; quotaPeriod:string|null; quotaAction:string|null; usedBytes:string; usedDownloadBytes:string; usedUploadBytes:string; remainingBytes:string|null; exhausted:boolean; }
export interface HistorySample { bucketStart:string; downloadBytes:string|number; uploadBytes:string|number; }
export interface LiveTraffic { mac:string; ip:string|null; hostname:string|null; downloadRateBps:string|number; uploadRateBps:string|number; }
export interface LoginResponse { token:string; expiresAt?:string; }
export interface VpnStatus { enabled:boolean; connected:boolean; vmessLink?:string|null; }
