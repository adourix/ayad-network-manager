import { statfs } from "node:fs/promises";
import { prisma } from "./prisma.js";
const DAY_MS=86400000;
export interface StorageSnapshot{databaseBytes:bigint;filesystemTotalBytes:bigint;filesystemFreeBytes:bigint;filesystemFreePercent:number;}
export class DatabaseStorageMonitor {
  private timer?:NodeJS.Timeout;private running=false;
  constructor(private readonly intervalMs=DAY_MS,private readonly databaseWarningBytes=2*1024*1024*1024,private readonly diskFreeWarningPercent=10,private readonly db:Pick<typeof prisma,"$queryRaw">=prisma,private readonly filesystemStats:typeof statfs=statfs,private readonly info:(message:string)=>void=console.info,private readonly warn:(message:string)=>void=console.warn){
    if(!Number.isInteger(intervalMs)||intervalMs<60000)throw new Error("Storage monitor interval must be at least one minute");
    if(databaseWarningBytes<1)throw new Error("Database warning threshold must be positive");
    if(!Number.isFinite(diskFreeWarningPercent)||diskFreeWarningPercent<1||diskFreeWarningPercent>50)throw new Error("Disk free warning percent must be between 1 and 50");
  }
  async start():Promise<void>{if(this.timer)return;await this.run();this.timer=setInterval(()=>{if(!this.running)void this.run();},this.intervalMs);this.timer.unref();}
  stop():void{if(!this.timer)return;clearInterval(this.timer);this.timer=undefined;}
  async run():Promise<StorageSnapshot|null>{if(this.running)return null;this.running=true;try{
    const rows=await this.db.$queryRaw<Array<{bytes:bigint}>>`SELECT pg_database_size(current_database())::bigint AS bytes`;
    const databaseBytes=BigInt(rows[0]?.bytes??0);const stats=await this.filesystemStats("/");
    const filesystemTotalBytes=BigInt(stats.blocks)*BigInt(stats.bsize),filesystemFreeBytes=BigInt(stats.bavail)*BigInt(stats.bsize);
    const filesystemFreePercent=filesystemTotalBytes>0n?Number(filesystemFreeBytes*10000n/filesystemTotalBytes)/100:0;
    const snapshot={databaseBytes,filesystemTotalBytes,filesystemFreeBytes,filesystemFreePercent};
    const dbMiB=(Number(databaseBytes)/1048576).toFixed(1),freeGiB=(Number(filesystemFreeBytes)/1073741824).toFixed(1);
    const message=`Storage snapshot: PostgreSQL ${dbMiB} MiB; filesystem free ${freeGiB} GiB (${filesystemFreePercent.toFixed(1)}%).`;
    if(databaseBytes>=BigInt(this.databaseWarningBytes))this.warn("PostgreSQL size warning: "+message);else if(filesystemFreePercent<=this.diskFreeWarningPercent)this.warn("Low disk space warning: "+message);else this.info(message);
    return snapshot;
  }catch(error){this.warn("Storage monitor failed; will retry on the next interval: "+(error instanceof Error?error.message:String(error)));return null;}finally{this.running=false;}}
}
