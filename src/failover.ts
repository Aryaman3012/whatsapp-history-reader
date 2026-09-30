// Engine failover for the pairing handshake.
//
// The failure this exists for: WhatsApp refuses Baileys at the registration
// handshake (status 405 on a retired client version, among others), so no QR is
// ever issued and the visitor stares at an empty pairing page. Nothing is paired
// at that point, so switching engines costs the visitor nothing — a QR simply
// appears a beat later, from the other engine.
//
// After a scan, failover is NOT available: the credentials belong to the engine
// that did the pairing, so a switch would mean asking the clinic to scan again.
import type { WaConnection, WaStatus } from './connection.js';

export interface FailoverArgs {
  primary: WaConnection;
  /** Builds and starts the second engine. Null when none is configured. */
  createFallback: (() => WaConnection) | null;
  /** How long the primary gets to produce a QR or a pairing code. */
  handshakeGraceMs: number;
  label: string;
  onFailover?: () => void;
}

export interface FailoverConnection extends WaConnection {
  /** Decide whether to hand over. The watchdog calls this; tests call it directly. */
  check(now?: number): Promise<void>;
  activeEngine(): 'primary' | 'fallback';
}

export function createFailoverConnection(args: FailoverArgs): FailoverConnection {
  const startedAt = Date.now();
  let active: WaConnection = args.primary;
  let which: 'primary' | 'fallback' = 'primary';
  let watchdog: NodeJS.Timeout | null = null;

  /** A handshake is alive once it has produced anything a human can act on. */
  function handshakeProgressed(): boolean {
    return (
      args.primary.isConnected() ||
      args.primary.getQR() !== null ||
      args.primary.getPairingCode() !== null
    );
  }

  async function check(now: number = Date.now()): Promise<void> {
    if (which === 'fallback' || !args.createFallback) return;
    if (handshakeProgressed()) return;
    if (now - startedAt <= args.handshakeGraceMs) return;

    console.log(
      `[failover:${args.label}] no QR after ${Math.round(
        args.handshakeGraceMs / 1000
      )}s — switching to the fallback engine.`
    );
    const fallback = args.createFallback();
    which = 'fallback';
    active = fallback;
    try {
      args.primary.close();
    } catch (err) {
      console.error(`[failover:${args.label}] closing the primary failed:`, err);
    }
    args.onFailover?.();
  }

  if (args.createFallback) {
    watchdog = setInterval(() => void check().catch(() => {}), 2000);
    watchdog.unref();
  }

  return {
    check,
    activeEngine: () => which,
    getQR: () => active.getQR(),
    getPairingCode: () => active.getPairingCode(),
    isConnected: () => active.isConnected(),
    getStatus: (): WaStatus => active.getStatus(),
    getSyncProgress: () => active.getSyncProgress(),
    getLastSyncBatchAt: () => active.getLastSyncBatchAt(),
    async logout(): Promise<void> {
      if (watchdog) clearInterval(watchdog);
      await active.logout();
    },
    close(): void {
      if (watchdog) clearInterval(watchdog);
      active.close();
    },
  };
}
