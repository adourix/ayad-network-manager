import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SetupService } from "../src/application/setup/SetupService.js";

test("setup inspection enumerates interfaces and proposes a non-overlapping subnet", async () => {
  const probe={run:async (command:string,args:string[])=>({stdout:
    command === "ip" && args[1] === "link" ? JSON.stringify([{ifname:"eno1",address:"aa:bb:cc:dd:ee:ff",operstate:"UP",link_type:"ether"}]) :
    command === "ip" && args[2] === "addr" ? JSON.stringify([{ifname:"eno1",addr_info:[{family:"inet",local:"192.168.1.254",prefixlen:24}]}]) :
    command === "ip" ? JSON.stringify([{dev:"eno1"}]) : "",stderr:""})};
  const report=await new SetupService(probe).inspectNetwork();
  assert.equal(report.defaultUplink,"eno1");
  assert.deepEqual(report.interfaces[0]?.addresses,["192.168.1.254/24"]);
  assert.ok(report.proposedClientSubnets.includes("192.168.50.0/24"));
});

test("setup apply renders atomically and rolls back when health checks fail", async () => {
  const root=await mkdtemp(join(tmpdir(),"network-control-setup-"));
  const configPath=join(root,"config.env"), dnsmasqPath=join(root,"clients.conf");
  await writeFile(configPath,"OLD=1\n"); await writeFile(dnsmasqPath,"old\n");
  const probe={run:async (command:string,args:string[])=>{
    if(command === "ss")return {stdout:"",stderr:""};
    if(command === "modprobe")return {stdout:"",stderr:""};
    if(command === "ufw")return {stdout:"Status: inactive",stderr:""};
    if(command === "timedatectl")return {stdout:"yes",stderr:""};
    if(command === "nft")return {stdout:"table ip filter {}",stderr:""};
    if(command === "ip" && args[1] === "link")return {stdout:JSON.stringify([{ifname:"eno1",address:"aa:bb:cc:dd:ee:ff",operstate:"UP",link_type:"ether"}]),stderr:""};
    if(command === "ip" && args[2] === "addr")return {stdout:JSON.stringify([{ifname:"eno1",addr_info:[{family:"inet",local:"192.168.1.254",prefixlen:24}]}]),stderr:""};
    if(command === "ip")return {stdout:args.includes("addr")?"eno1":"",stderr:""};
    if(command === "ping")throw new Error("unreachable");
    if(command === "test")throw new Error("no lease");
    return {stdout:"",stderr:""};
  }};
  const service=new SetupService(probe,{configPath,dnsmasqPath,snapshotDir:join(root,"backups")});
  const result=await service.apply({clientInterface:"eno1",uplinkInterface:"eno1",clientSubnet:"192.168.1.0/24",uplinkBandwidthMbps:100,dashboardPort:5000,sshPort:22,dnsServers:["1.1.1.1"],activate:false});
  assert.equal(result.applied,false); assert.equal(result.rolledBack,true); assert.equal(await readFile(configPath,"utf8"),"OLD=1\n");
});
