export interface VpnState { vmessLink:string|null; enabled:boolean; connected:boolean; lastConnectedAt:Date|null; }
export interface VpnRepository { get():Promise<VpnState>; saveLink(link:string):Promise<VpnState>; setEnabled(enabled:boolean):Promise<VpnState>; setConnected(connected:boolean):Promise<VpnState>; }
