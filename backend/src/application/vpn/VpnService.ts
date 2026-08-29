import type { VpnRepository, VpnState } from "../../domain/repositories/VpnRepository.js";
import type { OperationsRepository } from "../../domain/repositories/OperationsRepository.js";
export interface VpnEnforcement { apply(enabled:boolean):Promise<boolean>; configure?(link:string):Promise<void>; }
export class VpnService {
  constructor(private readonly repository:VpnRepository,private readonly enforcement:VpnEnforcement,private readonly audit?:OperationsRepository){}
  status(){return this.repository.get();}
  async configure(link:string){if(!/^vmess:\/\//i.test(link.trim()))throw new Error("Only vmess links are supported");await this.enforcement.configure?.(link.trim());const result=await this.repository.saveLink(link.trim());await this.audit?.audit({action:"configure-vpn",details:{result:"success"}});return result;}
  async setEnabled(enabled:boolean){const state=await this.repository.get();if(enabled&&!state.vmessLink)throw new Error("Configure a vmess link first");const connected=await this.enforcement.apply(enabled);await this.repository.setEnabled(enabled);const result=await this.repository.setConnected(enabled&&connected);await this.audit?.audit({action:enabled?"enable-vpn":"disable-vpn",details:{connected:result.connected,result:"success"}});return result;}
}
