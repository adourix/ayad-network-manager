import assert from "node:assert/strict";
import test from "node:test";
import { ScheduleEnforcementService } from "../src/application/policies/ScheduleEnforcementService.js";
import { DevicePolicyService } from "../src/application/policies/DevicePolicyService.js";

test("schedule enforcement applies active values and restores base values outside the window", async () => {
  const calls:string[]=[];
  const device={mac:{toString:()=>"aa:bb:cc:dd:ee:ff"},ip:{toString:()=>"192.168.1.42"}} as any;
  const policy={scheduleId:1,blocked:false,downloadLimit:5n,uploadLimit:2n} as any;
  const devices={findAll:async()=>[device]};
  const policies={findByDeviceId:async()=>policy};
  const catalog={schedules:async()=>[{id:1,name:"work",description:null,rules:[{id:1,dayOfWeek:1,startTime:"09:00",endTime:"10:00",downloadLimit:1n,uploadLimit:1n,blocked:true}]}]};
  const traffic={limitDownload:async(_m:string,v:any)=>calls.push(`down:${v.rateMbps}`),limitUpload:async(_m:string,v:any)=>calls.push(`up:${v.rateMbps}`),clearDownload:async()=>calls.push("down:clear"),clearUpload:async()=>calls.push("up:clear")};
  const firewall={blockDevice:async()=>calls.push("block"),unblockDevice:async()=>calls.push("unblock")};
  const service=new ScheduleEnforcementService(devices as any,policies as any,catalog as any,traffic as any,firewall as any,30_000,()=>new Date(2026,7,31,9,30));
  await service.reconcile();
  assert.deepEqual(calls,["block","down:1","up:1"]);
  calls.length=0;
  const outside=new ScheduleEnforcementService(devices as any,policies as any,catalog as any,traffic as any,firewall as any,30_000,()=>new Date(2026,7,31,11,0));
  await outside.reconcile();
  assert.deepEqual(calls,["down:5","up:2"]);
});

test("assigning a profile immediately inherits limits and quota", async () => {
  const updates:any[]=[];
  const device={id:4,mac:{toString:()=>"aa:bb:cc:dd:ee:04"},ip:{toString:()=>"192.168.1.44"}} as any;
  const base={id:1,deviceId:4,blocked:false,downloadLimit:null,uploadLimit:null,quota:null,quotaPeriod:null,quotaAction:null,quotaEnforcedAction:null,profileId:9,scheduleId:null};
  const inherited={...base,downloadLimit:20n,uploadLimit:5n,quota:1000n,quotaPeriod:"monthly"};
  const repository={upsert:async(_id:number,data:any)=>{updates.push(data);return updates.length===1?base:inherited;},findByDeviceId:async()=>inherited};
  const catalog={profiles:async()=>[{id:9,name:"Normal",description:null,downloadLimit:20n,uploadLimit:5n,quota:1000n,quotaPeriod:"monthly"}]};
  const traffic={limitDownload:async(_m:string,v:any)=>updates.push({down:v.rateMbps}),limitUpload:async(_m:string,v:any)=>updates.push({up:v.rateMbps})};
  const service=new DevicePolicyService({findByMac:async()=>device} as any,repository as any,catalog as any,traffic as any);
  await service.upsertDevicePolicy(device.mac.toString(),{profileId:9});
  assert.deepEqual(updates,[{profileId:9},{downloadLimit:20n,uploadLimit:5n,quota:1000n,quotaPeriod:"monthly"},{down:20n},{up:5n}]);
});
