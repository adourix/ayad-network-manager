import type { PolicyCatalogRepository, ProfileRecord, ScheduleRecord, PortRuleRecord, ScheduleRuleRecord } from "../../domain/repositories/PolicyCatalogRepository.js";
import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import type { PortRuleEnforcer } from "../enforcement/PortRuleEnforcer.js";

function id(value:number){if(!Number.isSafeInteger(value)||value<=0)throw new Error("Invalid id");return value;}
function rule(value:Omit<ScheduleRuleRecord,"id">):Omit<ScheduleRuleRecord,"id">{
  if(!Number.isInteger(value.dayOfWeek)||value.dayOfWeek<0||value.dayOfWeek>6)throw new Error("dayOfWeek must be 0..6");
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.startTime)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.endTime))throw new Error("Schedule times must be HH:MM");
  return value;
}
export class PolicyCatalogService {
  constructor(private readonly repository:PolicyCatalogRepository,private readonly devices?:DeviceRepository,private readonly portEnforcer?:PortRuleEnforcer){}
  profiles(){return this.repository.profiles();}
  createProfile(data:Omit<ProfileRecord,"id">){if(!data.name.trim())throw new Error("Profile name is required");return this.repository.createProfile(data);}
  updateProfile(idValue:number,data:Partial<Omit<ProfileRecord,"id">>){return this.repository.updateProfile(id(idValue),data);}
  deleteProfile(idValue:number){return this.repository.deleteProfile(id(idValue));}
  schedules(){return this.repository.schedules();}
  createSchedule(data:{name:string;description:string|null;rules:Array<Omit<ScheduleRuleRecord,"id">>}){if(!data.name.trim())throw new Error("Schedule name is required");return this.repository.createSchedule({...data,rules:data.rules.map(rule)});}
  updateSchedule(idValue:number,data:{name?:string;description?:string|null;rules?:Array<Omit<ScheduleRuleRecord,"id">>}){return this.repository.updateSchedule(id(idValue),{...(data.name===undefined?{}:{name:data.name}),...(data.description===undefined?{}:{description:data.description}),...(data.rules===undefined?{}:{rules:data.rules.map(rule)})});}
  deleteSchedule(idValue:number){return this.repository.deleteSchedule(id(idValue));}
  portRules(deviceId:number){return this.repository.portRules(id(deviceId));}
  async createPortRule(data:Omit<PortRuleRecord,"id">){if(!["tcp","udp"].includes(data.protocol)||!Number.isInteger(data.port)||data.port<1||data.port>65535||!["allow","block"].includes(data.action))throw new Error("Invalid port rule");const device=this.devices&&await this.devices.findById(data.deviceId);if(!device?.ip)throw new Error("Device not found or has no current IP");const created=await this.repository.createPortRule(data);try { if(this.portEnforcer&&data.enabled)await this.portEnforcer.apply({mac:device.mac.toString(),ip:device.ip.toString()},created); } catch(error) { await this.repository.deletePortRule(created.id); throw error; } return created;}
  async deletePortRule(idValue:number){const target=id(idValue);const found=await this.repository.portRule(target);if(found&&this.portEnforcer)await this.portEnforcer.remove(found);return this.repository.deletePortRule(target);}
}
