import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { DevicePolicyRepository } from "../../domain/repositories/DevicePolicyRepository.js";
import type { PolicyCatalogRepository, ScheduleRuleRecord } from "../../domain/repositories/PolicyCatalogRepository.js";
import type { TrafficEnforcementService } from "../enforcement/TrafficEnforcementService.js";
import type { FirewallService } from "../enforcement/FirewallService.js";

/** Applies the active rule and restores the persisted policy outside its window. */
export class ScheduleEnforcementService {
  private timer:NodeJS.Timeout|undefined;
  private running=false;
  constructor(private readonly devices:DeviceRepository,private readonly policies:DevicePolicyRepository,private readonly catalog:PolicyCatalogRepository,private readonly traffic:TrafficEnforcementService,private readonly firewall:FirewallService,private readonly intervalMs=30_000,private readonly now=()=>new Date()){}
  async start(){if(this.timer)return;await this.reconcile();this.timer=setInterval(()=>void this.reconcile(),this.intervalMs);}
  stop(){if(this.timer){clearInterval(this.timer);this.timer=undefined;}}
  async reconcile(){if(this.running)return;this.running=true;try{const now=this.now();const day=now.getDay();const minutes=now.getHours()*60+now.getMinutes();const schedules=await this.catalog.schedules();for(const device of await this.devices.findAll()){const policy=await this.policies.findByDeviceId(device.id);if(!policy?.scheduleId)continue;const schedule=schedules.find(x=>x.id===policy.scheduleId);const active=schedule?.rules.find((r:ScheduleRuleRecord)=>r.dayOfWeek===day&&this.inWindow(r,minutes));const blocked=active?.blocked??policy.blocked;if(blocked!==policy.blocked){if(blocked)await this.firewall.blockDevice(device.mac.toString());else await this.firewall.unblockDevice(device.mac.toString());}if(!device.ip)continue;const download=active?active.downloadLimit:policy.downloadLimit;const upload=active?active.uploadLimit:policy.uploadLimit;if(download!==null)await this.traffic.limitDownload(device.mac.toString(),{rateMbps:download});else await this.traffic.clearDownload(device.mac.toString());if(upload!==null)await this.traffic.limitUpload(device.mac.toString(),{rateMbps:upload});else await this.traffic.clearUpload(device.mac.toString());}}finally{this.running=false;}}
  private inWindow(rule:ScheduleRuleRecord,minutes:number){const parse=(v:string)=>{const [h,m]=v.split(":").map(Number);return (h??0)*60+(m??0);};const start=parse(rule.startTime),end=parse(rule.endTime);return start<=end?minutes>=start&&minutes<end:minutes>=start||minutes<end;}
}
