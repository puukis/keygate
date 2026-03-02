import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import type { ConnectionState, WASocket } from '@whiskeysockets/baileys';
import {
  clearWhatsAppAuthState,
  readWhatsAppLinkedAccountMeta,
  writeWhatsAppLinkedAccountMeta,
} from './auth.js';
import { normalizeWhatsAppPhoneNumber } from './normalize.js';
import {
  createWhatsAppSocket,
  isLoggedOutDisconnect,
  isRestartRequiredDisconnect,
  type WhatsAppSocketContext,
} from './session.js';

export interface WhatsAppLoginQrState {
  id: string;
  qrDataUrl: string | null;
  statusText: string;
}

export interface WhatsAppLoginResult {
  ok: boolean;
  reason: 'linked' | 'timeout' | 'cancelled' | 'logged_out' | 'disconnected' | 'error';
  linkedPhone: string | null;
  error?: string;
}

interface ActiveWhatsAppLogin {
  id: string;
  qrDataUrl: string | null;
  statusText: string;
  socket: WhatsAppSocketContext;
  options: StartWhatsAppLoginOptions;
  timer: NodeJS.Timeout;
  restarting: boolean;
  settled: boolean;
  resultPromise: Promise<WhatsAppLoginResult>;
  resolve: (result: WhatsAppLoginResult) => void;
}

export interface StartWhatsAppLoginOptions {
  force?: boolean;
  timeoutMs?: number;
  printQrToTerminal?: boolean;
  onQr?: (state: WhatsAppLoginQrState) => void | Promise<void>;
}

let activeLogin: ActiveWhatsAppLogin | null = null;
let lastLoginResultPromise: Promise<WhatsAppLoginResult> | null = null;

export async function startWhatsAppLogin(options: StartWhatsAppLoginOptions = {}): Promise<WhatsAppLoginQrState> {
  await cancelActiveWhatsAppLogin();

  if (options.force) {
    await clearWhatsAppAuthState();
  }

  let resolveResult: ((result: WhatsAppLoginResult) => void) | null = null;
  const resultPromise = new Promise<WhatsAppLoginResult>((resolve) => {
    resolveResult = resolve;
  });
  lastLoginResultPromise = resultPromise;
  const loginId = randomUUID();

  const socket = await createLoginSocket(loginId, options);

  const timer = setTimeout(() => {
    void settleActiveLogin({
      ok: false,
      reason: 'timeout',
      linkedPhone: null,
      error: 'WhatsApp login timed out before the QR was linked.',
    });
  }, Math.max(10_000, options.timeoutMs ?? 120_000));

  activeLogin = {
    id: loginId,
    qrDataUrl: null,
    statusText: 'Waiting for a QR code...',
    socket,
    options,
    timer,
    restarting: false,
    settled: false,
    resultPromise,
    resolve: resolveResult!,
  };

  return {
    id: loginId,
    qrDataUrl: activeLogin.qrDataUrl,
    statusText: activeLogin.statusText,
  };
}

async function handleLoginConnectionUpdate(
  loginId: string,
  update: ConnectionState,
  sock: WASocket,
): Promise<void> {
  if (!activeLogin || activeLogin.id !== loginId || activeLogin.settled) {
    return;
  }

  if (activeLogin.socket.sock !== sock && !activeLogin.restarting) {
    return;
  }

  if (update.connection === 'open') {
    const jid = typeof sock?.user?.id === 'string' ? sock.user.id : undefined;
    const phoneNumber = normalizeWhatsAppPhoneNumber(jid);
    const existing = await readWhatsAppLinkedAccountMeta();
    await writeWhatsAppLinkedAccountMeta({
      ...existing,
      jid,
      phoneNumber,
    });

    await settleActiveLogin({
      ok: true,
      reason: 'linked',
      linkedPhone: phoneNumber,
    });
    return;
  }

  if (update.connection === 'close') {
    if (isRestartRequiredDisconnect(update)) {
      await restartActiveLoginSocket(loginId);
      return;
    }

    if (isLoggedOutDisconnect(update)) {
      await clearWhatsAppAuthState();
      await settleActiveLogin({
        ok: false,
        reason: 'logged_out',
        linkedPhone: null,
        error: 'WhatsApp logged out the linked session.',
      });
      return;
    }

    await settleActiveLogin({
      ok: false,
      reason: 'disconnected',
      linkedPhone: null,
      error: 'WhatsApp login disconnected before completion.',
    });
  }
}

async function createLoginSocket(
  loginId: string,
  options: StartWhatsAppLoginOptions
): Promise<WhatsAppSocketContext> {
  return createWhatsAppSocket({
    onQr: async (qr) => {
      if (!activeLogin || activeLogin.id !== loginId) {
        return;
      }

      const qrDataUrl = await QRCode.toDataURL(qr, {
        type: 'image/png',
        margin: 1,
        scale: 8,
      });

      activeLogin.qrDataUrl = qrDataUrl;
      activeLogin.statusText = 'Scan the QR code in WhatsApp > Linked Devices.';
      if (options.printQrToTerminal) {
        qrcodeTerminal.generate(qr, { small: true });
      }
      await options.onQr?.({
        id: loginId,
        qrDataUrl,
        statusText: activeLogin.statusText,
      });
    },
    onConnectionUpdate: async (update, nextSock) => {
      await handleLoginConnectionUpdate(loginId, update, nextSock);
    },
  });
}

async function restartActiveLoginSocket(loginId: string): Promise<void> {
  const login = activeLogin;
  if (!login || login.id !== loginId || login.settled || login.restarting) {
    return;
  }

  login.restarting = true;
  login.statusText = 'Pairing accepted. Finalizing login...';

  try {
    const nextSocket = await createLoginSocket(loginId, login.options);
    if (!activeLogin || activeLogin.id !== loginId || activeLogin.settled) {
      await nextSocket.close();
      return;
    }

    activeLogin.socket = nextSocket;
    activeLogin.restarting = false;
  } catch (error) {
    login.restarting = false;
    await settleActiveLogin({
      ok: false,
      reason: 'error',
      linkedPhone: null,
      error: error instanceof Error
        ? error.message
        : 'WhatsApp login could not restart after pairing.',
    });
  }
}

async function settleActiveLogin(result: WhatsAppLoginResult): Promise<WhatsAppLoginResult> {
  const login = activeLogin;
  if (!login || login.settled) {
    return result;
  }

  login.settled = true;
  clearTimeout(login.timer);
  activeLogin = null;
  await login.socket.close();
  login.resolve(result);
  return result;
}

export function getActiveWhatsAppLoginSnapshot(): WhatsAppLoginQrState | null {
  if (!activeLogin) {
    return null;
  }

  return {
    id: activeLogin.id,
    qrDataUrl: activeLogin.qrDataUrl,
    statusText: activeLogin.statusText,
  };
}

export async function waitForActiveWhatsAppLoginResult(): Promise<WhatsAppLoginResult | null> {
  return activeLogin?.resultPromise ?? lastLoginResultPromise;
}

export async function cancelActiveWhatsAppLogin(): Promise<WhatsAppLoginResult | null> {
  if (!activeLogin) {
    return null;
  }

  return settleActiveLogin({
    ok: false,
    reason: 'cancelled',
    linkedPhone: null,
    error: 'WhatsApp login was cancelled.',
  });
}

export async function logoutWhatsAppLinkedDevice(): Promise<void> {
  await cancelActiveWhatsAppLogin();
  await clearWhatsAppAuthState();
}
