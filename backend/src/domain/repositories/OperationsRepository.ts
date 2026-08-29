export interface AuditRecord { id:bigint; action:string; mac:string|null; deviceId:number|null; details:unknown; createdAt:Date; }
export interface NotificationRecord { id:number; deviceId:number|null; type:string; message:string; readAt:Date|null; createdAt:Date; }
export interface OperationsRepository {
  audit(data:{action:string;mac?:string|null;deviceId?:number|null;details?:unknown}):Promise<void>;
  audits(limit:number):Promise<AuditRecord[]>;
  notifications():Promise<NotificationRecord[]>;
  markNotificationRead(id:number):Promise<void>;
}
