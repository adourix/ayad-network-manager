import { prisma } from "./prisma.js";
import type { Device } from "../../domain/entities/Device.js";
import type { DeviceRepository } from "../../domain/repositories/DeviceRepository.js";
import { IpAddress } from "../../domain/value-objects/IpAddress.js";
import { MacAddress } from "../../domain/value-objects/MacAddress.js";
import type { IdentitySource, ValidatedDeviceIdentity } from "../../domain/services/DeviceIdentityValidator.js";
import { reconcileIdentityObservation } from "../../domain/services/IdentityStateReconciler.js";

function toDomain(row: { id:number; mac:string; ip:string|null; hostname:string|null; l2Visible:boolean; proxyMac:string|null; identityValidated:boolean; identitySource:IdentitySource; firstSeen:Date; lastSeen:Date }): Device {
  return { id:row.id, mac:MacAddress.create(row.mac), ip:row.ip ? IpAddress.create(row.ip) : null, hostname:row.hostname, l2Visible:row.l2Visible, proxyMac:row.proxyMac ? MacAddress.create(row.proxyMac) : null, identityValidated:row.identityValidated, identitySource:row.identitySource, firstSeen:row.firstSeen, lastSeen:row.lastSeen };
}

export class PrismaDeviceRepository implements DeviceRepository {
  private async assertNotProxyMac(mac:string, excludingDeviceId?:number):Promise<void> {
    const owner=await prisma.device.findFirst({where:{proxyMac:mac,...(excludingDeviceId!==undefined?{id:{not:excludingDeviceId}}:{})},select:{id:true}});
    if(owner) throw new Error(`Refusing to create or persist proxy MAC as a device identity: ${mac}`);
  }
  async findByMac(mac:MacAddress):Promise<Device|null>{const row=await prisma.device.findUnique({where:{mac:mac.toString()}});return row?toDomain(row):null;}
  async findById(id:number):Promise<Device|null>{const row=await prisma.device.findUnique({where:{id}});return row?toDomain(row):null;}
  async findAll():Promise<Device[]>{const rows=await prisma.device.findMany({orderBy:{id:"asc"}});return rows.map(toDomain);}
  async upsert(data:{mac:MacAddress;ip:IpAddress;hostname:string|null;l2Visible:boolean;proxyMac:MacAddress|null;identityValidated?:boolean;identitySource?:IdentitySource;seenAt:Date}):Promise<Device>{
    const mac=data.mac.toString(); const proxyMac=data.proxyMac?.toString()??null; await this.assertNotProxyMac(mac); if(proxyMac===mac)throw new Error(`Device MAC cannot also be its proxy MAC: ${mac}`);
    const existing=await this.findByMac(data.mac);
    const observed:ValidatedDeviceIdentity={mac,ip:data.ip.toString(),hostname:data.hostname,clientId:null,neighborState:"UNKNOWN",l2Visible:data.l2Visible??true,proxyMac,identityValidated:data.identityValidated??true,identitySource:data.identitySource??"DHCP"};
    const reconciled=reconcileIdentityObservation(existing,observed); await this.assertNotProxyMac(reconciled.mac,existing?.id); if(reconciled.proxyMac===reconciled.mac)throw new Error(`Device MAC cannot also be its proxy MAC: ${reconciled.mac}`);
    const row=await prisma.device.upsert({where:{mac},create:{mac:reconciled.mac,ip:reconciled.ip,hostname:reconciled.hostname,l2Visible:reconciled.l2Visible,proxyMac:reconciled.proxyMac,identityValidated:reconciled.identityValidated,identitySource:reconciled.identitySource,firstSeen:data.seenAt,lastSeen:data.seenAt},update:{ip:reconciled.ip,hostname:reconciled.hostname,l2Visible:reconciled.l2Visible,proxyMac:reconciled.proxyMac,identityValidated:reconciled.identityValidated,identitySource:reconciled.identitySource,lastSeen:data.seenAt}}); return toDomain(row);
  }
  async create(data:{mac:MacAddress;ip:IpAddress;hostname:string|null;l2Visible?:boolean;proxyMac?:MacAddress|null;identityValidated?:boolean;identitySource?:IdentitySource}):Promise<Device>{const mac=data.mac.toString();const proxyMac=data.proxyMac?.toString()??null;await this.assertNotProxyMac(mac);if(proxyMac===mac)throw new Error(`Device MAC cannot also be its proxy MAC: ${mac}`);const row=await prisma.device.create({data:{mac,ip:data.ip.toString(),hostname:data.hostname,l2Visible:data.l2Visible??true,proxyMac,identityValidated:data.identityValidated??true,identitySource:data.identitySource??"DHCP"}});return toDomain(row);}
  async update(id:number,data:{ip?:IpAddress;hostname?:string|null;l2Visible?:boolean;proxyMac?:MacAddress|null;identityValidated?:boolean;identitySource?:IdentitySource;lastSeen?:Date}):Promise<Device>{const existing=await this.findById(id);if(!existing)throw new Error(`Device not found: ${id}`);const nextProxyMac=data.proxyMac!==undefined?data.proxyMac?.toString()??null:existing.proxyMac?.toString()??null;if(nextProxyMac===existing.mac.toString())throw new Error(`Device MAC cannot also be its proxy MAC: ${existing.mac}`);const row=await prisma.device.update({where:{id},data:{...(data.ip!==undefined&&{ip:data.ip.toString()}),...(data.hostname!==undefined&&{hostname:data.hostname}),...(data.lastSeen!==undefined&&{lastSeen:data.lastSeen}),...(data.l2Visible!==undefined&&{l2Visible:data.l2Visible}),...(data.proxyMac!==undefined&&{proxyMac:nextProxyMac}),...(data.identityValidated!==undefined&&{identityValidated:data.identityValidated}),...(data.identitySource!==undefined&&{identitySource:data.identitySource})}});return toDomain(row);}
}
