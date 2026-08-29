import type { PortRuleRecord } from "../../domain/repositories/PolicyCatalogRepository.js";
export interface PortRuleEnforcer {
  apply(device:{mac:string;ip:string},rule:PortRuleRecord):Promise<void>;
  remove(rule:PortRuleRecord):Promise<void>;
  reconcile?(devices: Array<{mac:string;ip:string|null;portRules:PortRuleRecord[]}>): Promise<void>;
}
