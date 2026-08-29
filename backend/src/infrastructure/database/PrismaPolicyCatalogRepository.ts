import { prisma } from "./prisma.js";
import type { PolicyCatalogRepository, ProfileRecord, ScheduleRecord, PortRuleRecord, ScheduleRuleRecord } from "../../domain/repositories/PolicyCatalogRepository.js";

const profile = (r:any):ProfileRecord => ({id:r.id,name:r.name,description:r.description,downloadLimit:r.downloadLimit,uploadLimit:r.uploadLimit,quota:r.quota,quotaPeriod:r.quotaPeriod});
const rule = (r:any):ScheduleRuleRecord => ({id:r.id,dayOfWeek:r.dayOfWeek,startTime:r.startTime,endTime:r.endTime,downloadLimit:r.downloadLimit,uploadLimit:r.uploadLimit,blocked:r.blocked});
const schedule = (r:any):ScheduleRecord => ({id:r.id,name:r.name,description:r.description,rules:r.rules.map(rule)});
const port = (r:any):PortRuleRecord => ({id:r.id,deviceId:r.deviceId,name:r.name,protocol:r.protocol,port:r.port,action:r.action,enabled:r.enabled});

export class PrismaPolicyCatalogRepository implements PolicyCatalogRepository {
  async profiles(){return (await prisma.profile.findMany({orderBy:{name:"asc"}})).map(profile);}
  async createProfile(data:Omit<ProfileRecord,"id">){return profile(await prisma.profile.create({data}));}
  async updateProfile(id:number,data:Partial<Omit<ProfileRecord,"id">>){return profile(await prisma.profile.update({where:{id},data}));}
  async deleteProfile(id:number){await prisma.profile.delete({where:{id}});}
  async schedules(){return (await prisma.schedule.findMany({include:{rules:true},orderBy:{name:"asc"}})).map(schedule);}
  async createSchedule(data:{name:string;description:string|null;rules:Array<Omit<ScheduleRuleRecord,"id">>}){
    const row=await prisma.schedule.create({data:{name:data.name,description:data.description,rules:{create:data.rules}} ,include:{rules:true}}); return schedule(row);
  }
  async updateSchedule(id:number,data:{name?:string;description?:string|null;rules?:Array<Omit<ScheduleRuleRecord,"id">>}){
    const row=await prisma.$transaction(async tx=>{if(data.rules){await tx.scheduleRule.deleteMany({where:{scheduleId:id}});} return tx.schedule.update({where:{id},data:{...(data.name===undefined?{}:{name:data.name}),...(data.description===undefined?{}:{description:data.description}),...(data.rules===undefined?{}:{rules:{create:data.rules}})},include:{rules:true}});}); return schedule(row);
  }
  async deleteSchedule(id:number){await prisma.schedule.delete({where:{id}});}
  async portRules(deviceId:number){return (await prisma.portRule.findMany({where:{deviceId},orderBy:{id:"asc"}})).map(port);}
  async portRule(id:number){const row=await prisma.portRule.findUnique({where:{id}});return row?port(row):null;}
  async createPortRule(data:Omit<PortRuleRecord,"id">){return port(await prisma.portRule.create({data}));}
  async deletePortRule(id:number){await prisma.portRule.delete({where:{id}});}
}
