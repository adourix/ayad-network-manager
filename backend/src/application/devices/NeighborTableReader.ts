export interface NeighborEntry {
  ip: string;
  mac: string;
  state: string;
}

export interface NeighborTableReader {
  read(interfaceName: string): Promise<NeighborEntry[]>;
}
