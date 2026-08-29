export interface NeighborObservationRepository {
  observe(mac: string, ip: string, state: string, seenAt: Date): Promise<number>;
  resetMissing(keys: string[], seenAt: Date): Promise<void>;
}
