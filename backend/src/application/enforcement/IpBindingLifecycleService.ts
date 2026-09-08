import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { DevicePolicyRepository } from "../../domain/repositories/DevicePolicyRepository.js";
import type { DhcpLeaseReader } from "../../domain/value-objects/NetworkObservation.js";
import type { BlockedDeviceRepository } from "../../domain/repositories/BlockedDeviceRepository.js";
import type { DeviceBlocker } from "./DeviceBlocker.js";

export class IpBindingLifecycleService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly deviceRepository:DeviceRepository,private readonly policyRepository:DevicePolicyRepository,private readonly dhcpLeaseReader:DhcpLeaseReader,private readonly blockedDeviceRepository:BlockedDeviceRepository,private readonly deviceBlocker:DeviceBlocker,private readonly intervalMs=10_000){}
  async start():Promise<void>{if(this.timer)return;await this.reconcile();this.timer=setInterval(()=>void this.reconcile(),this.intervalMs);}
  stop():void{if(!this.timer)return;clearInterval(this.timer);this.timer=undefined;}
  async reconcile():Promise<void>{if(this.running)return;this.running=true;try{const[devices,leases,bindings]=await Promise.all([this.deviceRepository.findAll(),this.dhcpLeaseReader.read(),this.blockedDeviceRepository.activeBindings()]);const deviceById=new Map(devices.map((device)=>[device.id,device]));const leaseIpByMac=new Map(leases.filter((lease)=>lease.expiry===0||lease.expiry>Math.floor(Date.now()/1000)).map((lease)=>[lease.mac.trim().toLowerCase(),lease.ip.trim()]));for(const binding of bindings){const device=deviceById.get(binding.deviceId);if(!device)continue;const policy=await this.policyRepository.findByDeviceId(device.id);if(!policy?.blocked||!device.identityValidated||device.l2Visible)continue;const currentIp=leaseIpByMac.get(device.mac.toString().toLowerCase());if(!currentIp||currentIp===binding.ip)continue;if(this.deviceBlocker.unblockIp)await this.deviceBlocker.unblockIp(binding.ip);await this.blockedDeviceRepository.releaseIp?.(binding.ip,`device ${device.id} moved to ${currentIp}`);}}finally{this.running=false;}}
}
