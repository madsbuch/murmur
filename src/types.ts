export interface Note {
  id: string;
  title: string;
  body: string;
  updatedAt: number;
}

export interface Network {
  id: string;
  name: string;
  invite: string;
}

export interface Snapshot {
  network: Network | null;
  notes: Note[];
  heads: string[];
  status: { peers: number; lastSync: number | null; error: string | null };
  deviceId: string;
  listenerPort: number;
}

export interface DraftBackup {
  networkId: string;
  id: string;
  title: string;
  body: string;
  baseHeads: string[];
}
