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
  phrase: string;
}

export interface Snapshot {
  network: Network | null;
  notes: Note[];
  files: SharedFile[];
  heads: string[];
  status: { peers: number; lastSync: number | null; error: string | null };
  deviceId: string;
  listenerPort: number;
}

export type Theme = 'system' | 'light' | 'dark';
export interface Settings { theme: Theme }
export interface SharedFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: number;
  available: boolean;
}
export interface FileContent { name: string; mimeType: string; dataBase64: string }
export interface PendingShare { id: string; name: string; mimeType: string; size: number }

export interface DraftBackup {
  networkId: string;
  id: string;
  title: string;
  body: string;
  baseHeads: string[];
}
