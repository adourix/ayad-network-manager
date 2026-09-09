import { prisma } from "./prisma.js";
import type { OperationsRepository, AuditRecord, NotificationRecord } from "../../domain/repositories/OperationsRepository.js";
export class PrismaOperationsRepository implements OperationsRepository {
  async audit(data:{action:string;mac?:string|null;deviceId?:number|null;details?:unknown}){await prisma.auditLog.create({data:{action:data.action,mac:data.mac??null,deviceId:data.deviceId??null,details:data.details as any}});}
  async audits(limit:number):Promise<AuditRecord[]>{const rows=await prisma.auditLog.findMany({orderBy:{createdAt:"desc"},take:Math.min(Math.max(limit,1),500)});return rows.map((r:any)=>({...r}));}
  async notifications():Promise<NotificationRecord[]>{return (await prisma.notification.findMany({orderBy:{createdAt:"desc"},take:500})).map((r:any)=>({...r}));}
  async markNotificationRead(id:number){await prisma.notification.update({where:{id},data:{readAt:new Date()}});}
}
