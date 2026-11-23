import { prisma } from "./prisma.js";
const DAY_MS=86400000;
export class NotificationRetentionService {
  private timer:NodeJS.Timeout | undefined; private running=false;
  constructor(private readonly intervalMs=3600000,private readonly retentionDays=90,private readonly batchSize=1000,private readonly maxBatchesPerRun=10,private readonly db:Pick<typeof prisma,"$executeRaw">=prisma,private readonly preservePendingDeliveries=false){
    if(!Number.isInteger(intervalMs)||intervalMs<60000)throw new Error("Notification cleanup interval must be at least one minute");
    if(!Number.isInteger(retentionDays)||retentionDays<7||retentionDays>3650)throw new Error("Notification retention must be between 7 and 3650 days");
    if(!Number.isInteger(batchSize)||batchSize<100||batchSize>50000)throw new Error("Notification cleanup batch size is out of range");
    if(!Number.isInteger(maxBatchesPerRun)||maxBatchesPerRun<1||maxBatchesPerRun>100)throw new Error("Notification cleanup batch count is out of range");
  }
  async start():Promise<void>{if(this.timer)return;await this.run();this.timer=setInterval(()=>{if(!this.running)void this.run();},this.intervalMs);this.timer.unref();}
  stop():void{if(!this.timer)return;clearInterval(this.timer);this.timer=undefined;}
  async run():Promise<number>{if(this.running)return 0;this.running=true;let total=0;try{
    const cutoff=new Date(Date.now()-this.retentionDays*DAY_MS);
    for(let i=0;i<this.maxBatchesPerRun;i++){const deleted=await this.db.$executeRaw`
      WITH expired AS (
        SELECT "id" FROM "notifications" WHERE "createdAt" < ${cutoff}
        AND (${this.preservePendingDeliveries}=false OR "deliveredAt" IS NOT NULL OR "deliveryAttempts" >= 8)
        ORDER BY "createdAt" ASC LIMIT ${this.batchSize}
      )
      DELETE FROM "notifications" WHERE "id" IN (SELECT "id" FROM expired)
    `;total+=deleted;if(deleted<this.batchSize)break;}
    if(total>0)console.info(`Notification retention removed ${total} expired rows (older than ${this.retentionDays} days).`);return total;
  }catch(error){console.error("Notification retention cleanup failed; will retry on the next interval:",error);return total;}finally{this.running=false;}}
}
