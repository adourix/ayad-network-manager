export type TrafficAccountingMode =
  | "single-interface-ifb"
  | "dual-interface";

export interface TrafficAccountingTopology {
  mode: TrafficAccountingMode;
  clientInterface: string;
  uplinkInterface: string | null;
  clientSubnet: string;
}
