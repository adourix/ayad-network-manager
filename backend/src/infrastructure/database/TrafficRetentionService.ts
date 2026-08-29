import { prisma } from "./prisma.js";
/** Keeps fine-grained samples bounded; the job is deliberately independent of request traffic. */
export class TrafficRetentionService {
  private timer:NodeJS.Timeout|undefined;
  constructor(private readonly intervalMs=60*60*1000, private readonly rawWindowMs=48*60*60*1000){}
  async start(){if(this.timer)return;await this.run();this.timer=setInterval(()=>void this.run(),this.intervalMs);}
  stop(){if(this.timer){clearInterval(this.timer);this.timer=undefined;}}
  async run(){
    const cutoff=new Date(Date.now()-this.rawWindowMs);
    const monthCutoff=new Date(Date.now()-30*24*60*60*1000);
    await prisma.$executeRaw`INSERT INTO "traffic_rollups" ("deviceId","bucketStart","granularity","downloadBytes","uploadBytes") SELECT "deviceId",date_trunc('hour',"timestamp"),'hourly',sum("downloadBytes"),sum("uploadBytes") FROM "traffic_samples" WHERE "timestamp" < ${cutoff} AND "timestamp" >= ${monthCutoff} GROUP BY "deviceId",date_trunc('hour',"timestamp") ON CONFLICT ("deviceId","bucketStart","granularity") DO UPDATE SET "downloadBytes"=EXCLUDED."downloadBytes","uploadBytes"=EXCLUDED."uploadBytes"`;
    await prisma.$executeRaw`INSERT INTO "traffic_rollups" ("deviceId","bucketStart","granularity","downloadBytes","uploadBytes") SELECT "deviceId",date_trunc('day',"timestamp"),'daily',sum("downloadBytes"),sum("uploadBytes") FROM "traffic_samples" WHERE "timestamp" < ${monthCutoff} GROUP BY "deviceId",date_trunc('day',"timestamp") ON CONFLICT ("deviceId","bucketStart","granularity") DO UPDATE SET "downloadBytes"=EXCLUDED."downloadBytes","uploadBytes"=EXCLUDED."uploadBytes"`;
    await prisma.trafficSample.deleteMany({where:{timestamp:{lt:cutoff}}});
  }
}
