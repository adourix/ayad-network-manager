import type { OperationsRepository } from "../../domain/repositories/OperationsRepository.js";
export class OperationsService {
  constructor(private readonly repository:OperationsRepository){}
  audits(limit=100){return this.repository.audits(limit);}
  notifications(){return this.repository.notifications();}
  markNotificationRead(id:number){if(!Number.isSafeInteger(id)||id<1)throw new Error("Invalid notification id");return this.repository.markNotificationRead(id);}
}
