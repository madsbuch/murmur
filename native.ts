import { addPluginListener, invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { errorText, integer, record, strings, text } from './src/validation';

type DiscoverySnapshot = {
  network: { id: string } | null;
  deviceId: string;
  listenerPort: number;
};

let latest: DiscoverySnapshot | undefined;
let activeKey = '';
let listenersReady: Promise<void> | undefined;
let chain = Promise.resolve();
let discoveryError = '';

function reportError(error: unknown) {
  activeKey = '';
  discoveryError = 'Nearby discovery: ' + errorText(error);
  window.dispatchEvent(new CustomEvent('murmur:discovery-error', { detail: discoveryError }));
}

function registerListeners(): Promise<void> {
  if (listenersReady === undefined) {
    listenersReady = (async () => {
      const onPeer = (value: unknown) => {
        try {
          const fields = record(value);
          const peer = { deviceId: text(fields['deviceId']), networkId: text(fields['networkId']), addresses: strings(fields['addresses']), port: integer(fields['port']) };
          if (peer.port === 0 || peer.port > 65535 || peer.addresses.length > 32) throw new Error('Invalid peer address.');
          void invoke<unknown>('peer_discovered', { peer }).catch(reportError);
        } catch (error) { reportError(error); }
      };
      const onError = (value: unknown) => {
        try { reportError(text(record(value)['message'])); }
        catch (error) { reportError(error); }
      };
      const cleanup: Array<() => void | Promise<void>> = [];
      try {
        const mobile = await invoke<unknown>('plugin:lan|is_mobile');
        if (typeof mobile !== 'boolean') throw new Error('Invalid platform response.');
        if (mobile) {
          const peers = await addPluginListener<unknown>('lan', 'peer', onPeer);
          cleanup.push(() => peers.unregister());
          const errors = await addPluginListener<unknown>('lan', 'error', onError);
          cleanup.push(() => errors.unregister());
        } else {
          cleanup.push(await listen<unknown>('lan-peer', event => onPeer(event.payload)));
          cleanup.push(await listen<unknown>('lan-error', event => onError(event.payload)));
        }
      } catch (error) {
        await Promise.allSettled(cleanup.map(async remove => { await remove(); }));
        throw error;
      }
    })().catch((error: unknown) => {
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
  chain = chain.catch(() => undefined).then(async () => {
    const current = latest;
    if (current === undefined) return;
    const key = current.network !== null ? current.network.id + ':' + current.listenerPort.toString() : '';
    if (key === activeKey) return;
    await registerListeners();
    await invoke<unknown>('plugin:lan|stop');
    activeKey = '';
    if (current.network !== null && current.listenerPort > 0) {
      await invoke<unknown>('plugin:lan|start', {
        config: {
          serviceName: 'Murmur-' + current.deviceId.slice(0, 8), port: current.listenerPort,
          networkId: current.network.id, deviceId: current.deviceId,
        },
      });
      activeKey = key;
      discoveryError = '';
    }
  });
  return chain.catch((error: unknown) => { reportError(error); });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && latest !== undefined && isTauri()) {
    activeKey = '';
    void initializeDiscovery(latest);
    void invoke<unknown>('sync_now').catch(reportError);
  }
});
