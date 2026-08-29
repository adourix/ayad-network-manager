import { prisma } from "./prisma.js";
import type { VpnRepository, VpnState } from "../../domain/repositories/VpnRepository.js";
const toState=(r:any):VpnState=>({vmessLink:r?.vmessLink??null,enabled:r?.enabled??false,connected:r?.connected??false,lastConnectedAt:r?.lastConnectedAt??null});
export class PrismaVpnRepository implements VpnRepository {
  async get(){return toState(await prisma.vpnConfig.findUnique({where:{id:1}}));}
  async saveLink(link:string){return toState(await prisma.vpnConfig.upsert({where:{id:1},create:{id:1,vmessLink:link},update:{vmessLink:link}}));}
  async setEnabled(enabled:boolean){return toState(await prisma.vpnConfig.upsert({where:{id:1},create:{id:1,vmessLink:"",enabled},update:{enabled}}));}
  async setConnected(connected:boolean){return toState(await prisma.vpnConfig.upsert({where:{id:1},create:{id:1,vmessLink:"",connected,lastConnectedAt:connected?new Date():null},update:{connected,lastConnectedAt:connected?new Date():null}}));}
}
