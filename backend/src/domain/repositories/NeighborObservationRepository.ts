export interface NeighborObservationInput {
  mac: string;
  ip: string;
  state: string;
}

export interface NeighborObservationRepository {
  observe(mac: string, ip: string, state: string, seenAt: Date): Promise<number>;
  observeMany?(observations: NeighborObservationInput[], seenAt: Date): Promise<Map<string, number>>;
  resetMissing(keys: string[], seenAt: Date): Promise<void>;
}
