declare module 'qrcode' {
  const QRCode: {
    toDataURL: (
      text: string,
      options?: Record<string, unknown>
    ) => Promise<string>;
  };
  export default QRCode;
}

declare module 'qrcode-terminal' {
  const qrcodeTerminal: {
    generate: (
      text: string,
      options?: Record<string, unknown>
    ) => void;
  };
  export default qrcodeTerminal;
}

declare module '@whiskeysockets/baileys' {
  export type AuthenticationState = any;
  export type ConnectionState = any;
  export type WASocket = any;

  export const makeWASocket: any;
  export default makeWASocket;

  export const Browsers: any;
  export const DisconnectReason: Record<string, number>;
  export const fetchLatestBaileysVersion: () => Promise<{ version: number[] }>;
  export const useMultiFileAuthState: (authDir: string) => Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
  }>;
  export const downloadMediaMessage: any;
}
