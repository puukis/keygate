import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type AuthenticationState,
  type ConnectionState,
  type WASocket,
} from '@whiskeysockets/baileys';
import { ensureWhatsAppAuthDir } from './auth.js';

export interface WhatsAppSocketContext {
  sock: WASocket;
  authState: AuthenticationState;
  saveCreds: () => Promise<void>;
  close: () => Promise<void>;
}

export interface CreateWhatsAppSocketOptions {
  onQr?: (qr: string) => void | Promise<void>;
  onConnectionUpdate?: (update: ConnectionState, sock: WASocket) => void | Promise<void>;
}

export async function createWhatsAppSocket(options: CreateWhatsAppSocketOptions = {}): Promise<WhatsAppSocketContext> {
  const authDir = await ensureWhatsAppAuthDir();
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.macOS('Keygate'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update: ConnectionState) => {
    if (update.qr) {
      void Promise.resolve(options.onQr?.(update.qr)).catch(() => undefined);
    }

    void Promise.resolve(options.onConnectionUpdate?.(update, sock)).catch(() => undefined);
  });

  return {
    sock,
    authState: state,
    saveCreds,
        close: async () => {
            try {
                (sock as unknown as { end?: () => void }).end?.();
            } catch {
                // Ignore shutdown failures.
            }
      try {
        (sock as unknown as { ws?: { close?: () => void } }).ws?.close?.();
      } catch {
        // Ignore shutdown failures.
      }
    },
  };
}

export function getDisconnectStatusCode(update: Partial<ConnectionState>): number | undefined {
  const error = update.lastDisconnect?.error as { output?: { statusCode?: unknown } } | undefined;
  const statusCode = error?.output?.statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

export function isLoggedOutDisconnect(update: Partial<ConnectionState>): boolean {
  return getDisconnectStatusCode(update) === DisconnectReason.loggedOut;
}

export function isRestartRequiredDisconnect(update: Partial<ConnectionState>): boolean {
  return getDisconnectStatusCode(update) === DisconnectReason.restartRequired;
}
