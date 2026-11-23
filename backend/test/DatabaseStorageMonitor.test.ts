import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseStorageMonitor } from "../src/infrastructure/database/DatabaseStorageMonitor.js";

test("storage monitor reports metrics and logs info when below thresholds",async()=>{
 const messages:string[]=[];
 const db={$queryRaw:async()=>[{bytes:1024n}]} as any;
 const stats=async()=>({blocks:1000n,bsize:1024n,bavail:500n}) as any;
 const monitor=new DatabaseStorageMonitor(60000,10000000,10,db,stats,m=>messages.push(m),m=>messages.push("WARN "+m));
 const result=await monitor.run();
 assert.equal(result?.databaseBytes,1024n);
 assert.equal(result?.filesystemTotalBytes,1024000n);
 assert.equal(result?.filesystemFreeBytes,512000n);
 assert.equal(result?.filesystemFreePercent,50);
 assert.equal(messages.length,1);
 assert.ok(messages[0]?.startsWith("Storage snapshot:"));
});

test("storage monitor independently warns on large database size",async()=>{
 const warnings:string[]=[];
 const db={$queryRaw:async()=>[{bytes:20000000n}]} as any;
 const stats=async()=>({blocks:1000n,bsize:1024n,bavail:500n}) as any;
 const monitor=new DatabaseStorageMonitor(60000,10000000,10,db,stats,()=>undefined,m=>warnings.push(m));
 const result=await monitor.run();
 assert.equal(result?.filesystemFreePercent,50);
 assert.equal(warnings.length,1);
 assert.ok(warnings[0]?.startsWith("PostgreSQL size warning:"));
});

test("storage monitor warns on low filesystem space independently",async()=>{
 const warnings:string[]=[];
 const db={$queryRaw:async()=>[{bytes:1024n}]} as any;
 const stats=async()=>({blocks:1000n,bsize:1024n,bavail:50n}) as any;
 const monitor=new DatabaseStorageMonitor(60000,10000000,10,db,stats,()=>undefined,m=>warnings.push(m));
 const result=await monitor.run();
 assert.equal(result?.filesystemFreePercent,5);
 assert.equal(warnings.length,1);
 assert.ok(warnings[0]?.startsWith("Low disk space warning:"));
});
