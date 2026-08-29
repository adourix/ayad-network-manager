import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { DevicePolicyRepository } from "../../domain/repositories/DevicePolicyRepository.js";
import type { PolicyCatalogRepository } from "../../domain/repositories/PolicyCatalogRepository.js";
import type { TrafficEnforcementService } from "../enforcement/TrafficEnforcementService.js";
export class ProfileEnforcementService {
  private timer:NodeJS.Timeout|undefined; private running=false;
  constructor(private readonly devices:DeviceRepository,private readonly policies:DevicePolicyRepository,private readonly catalog:PolicyCatalogRepository,private readonly traffic:TrafficEnforcementService,private readonly intervalMs=30_000){}
  async start(){if(this.timer)return;await this.reconcile();this.timer=setInterval(()=>void this.reconcile(),this.intervalMs);}
  stop(){if(this.timer){clearInterval(this.timer);this.timer=undefined;}}
  async reconcile(){if(this.running)return;this.running=true;try{const profiles=await this.catalog.profiles();for(const device of await this.devices.findAll()){const p=await this.policies.findByDeviceId(device.id);const profile=p?.profileId&&profiles.find(x=>x.id===p.profileId);if(!profile||!device.ip)continue;if(profile.downloadLimit!==null)await this.traffic.limitDownload(device.mac.toString(),{rateMbps:profile.downloadLimit});else await this.traffic.clearDownload(device.mac.toString());if(profile.uploadLimit!==null)await this.traffic.limitUpload(device.mac.toString(),{rateMbps:profile.uploadLimit});else await this.traffic.clearUpload(device.mac.toString());}}finally{this.running=false;}}
}
