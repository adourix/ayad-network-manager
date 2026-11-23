import assert from "node:assert/strict";
import test from "node:test";
process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
const { NotificationRetentionService } = await import("../src/infrastructure/database/NotificationRetentionService.js");
const { QuotaPeriodRetentionService } = await import("../src/infrastructure/database/QuotaPeriodRetentionService.js");
function fakeExecuteRaw(results:number[]){const statements:string[]=[];const db={$executeRaw:async(strings:TemplateStringsArray,..._values:unknown[])=>{statements.push(Array.from(strings).join("?"));return results.shift()??0;}};return{db:db as any,statements};}
test("notification retention batches old notifications and preserves pending deliveries when configured",async()=>{const{db,statements}=fakeExecuteRaw([1000,1000,17]);const service=new NotificationRetentionService(60000,90,1000,10,db,true);assert.equal(await service.run(),2017);assert.equal(statements.length,3);assert.ok(statements.every(sql=>sql.includes('"notifications"')&&sql.includes('"deliveredAt" IS NOT NULL')&&sql.includes('"deliveryAttempts" >= 8')&&sql.includes("LIMIT ?")));});
test("notification retention caps per-run deletion work",async()=>{const{db,statements}=fakeExecuteRaw([100,100,100]);const service=new NotificationRetentionService(60000,90,100,3,db);assert.equal(await service.run(),300);assert.equal(statements.length,3);});
test("quota retention removes expired periods in batches",async()=>{const{db,statements}=fakeExecuteRaw([5000,24]);const service=new QuotaPeriodRetentionService(60000,90,5000,10,db);assert.equal(await service.run(),5024);assert.equal(statements.length,2);assert.ok(statements.every(sql=>sql.includes('"quota_periods"')&&sql.includes('"periodEnd" < ?')&&sql.includes("LIMIT ?")));});
