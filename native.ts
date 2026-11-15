import { addPluginListener, invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type DiscoverySnapshot = {
  network: { id: string } | null;
  deviceId: string;
  listenerPort: number;
};
type Peer = { deviceId: string; networkId: string; addresses: string[]; port: number };

let latest: DiscoverySnapshot | undefined;
let activeKey = '';
let listenersReady: Promise<void> | undefined;
let chain = Promise.resolve();
let discoveryError = '';

function reportError(error: unknown) {
  activeKey = '';
  discoveryError = `Nearby discovery: ${String(error)}`;
  window.dispatchEvent(new CustomEvent('murmur:discovery-error', { detail: discoveryError }));
}

function registerListeners(): Promise<void> {
  if (!listenersReady) {
    listenersReady = (async () => {
      const onPeer = (peer: Peer) => {
        void invoke('peer_discovered', { peer }).catch(reportError);
      };
      const cleanup: Array<() => void | Promise<void>> = [];
      try {
        if (await invoke<boolean>('plugin:lan|is_mobile')) {
          const peers = await addPluginListener<Peer>('lan', 'peer', onPeer);
          cleanup.push(() => peers.unregister());
          const errors = await addPluginListener<{ message: string }>('lan', 'error', (event) => reportError(event.message));
          cleanup.push(() => errors.unregister());
        } else {
          cleanup.push(await listen<Peer>('lan-peer', (event) => onPeer(event.payload)));
          cleanup.push(await listen<{ message: string }>('lan-error', (event) => reportError(event.payload.message)));
        }
      } catch (error) {
        await Promise.allSettled(cleanup.map(remove => remove()));
        throw error;
      }
    })().catch((error) => {
      listenersReady = undefined;
      throw error;
    });
  }
  return listenersReady;
}

export function getDiscoveryError(): string { return discoveryError; }

export function initializeDiscovery(snapshot: DiscoverySnapshot): Promise<void> {
  latest = snapshot;
  if (!isTauri()) return Promise.resolve();
  chain = chain.catch(() => {}).then(async () => {
    const current = latest!;
    const key = current.network ? `${current.network.id}:${current.listenerPort}` : '';
    if (key === activeKey) return;
    await registerListeners();
    await invoke('plugin:lan|stop');
    activeKey = '';
    if (current.network && current.listenerPort > 0) {
      await invoke('plugin:lan|start', {
        config: {
          serviceName: `Murmur-${current.deviceId.slice(0, 8)}`,
          port: current.listenerPort,
          networkId: current.network.id,
          deviceId: current.deviceId,
        },
      });
      activeKey = key;
      discoveryError = '';
    }
  });
  return chain.catch((error) => { reportError(error); });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && latest && isTauri()) {
    activeKey = '';
    void initializeDiscovery(latest);
    void invoke('sync_now').catch(reportError);
  }
});
