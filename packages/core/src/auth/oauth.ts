import http from 'node:http';
import { URL } from 'node:url';
import { generateCodeVerifier, generateCodeChallenge, generateState } from './pkce.js';
import { writeTokens, type StoredTokens, type TokenStoreLocation } from './tokenStore.js';

const DEFAULT_AUTHORIZATION_ENDPOINT = 'https://auth.openai.com/oauth/authorize';
const DEFAULT_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const DEFAULT_REDIRECT_PORT = 1455;
const DEFAULT_REDIRECT_URI = `http://127.0.0.1:${DEFAULT_REDIRECT_PORT}/auth/callback`;
const DEFAULT_SCOPE = 'openai.chat';

export interface OAuthConfig {
  clientId: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  redirectUri?: string;
  redirectPort?: number;
  scope?: string;
}

export interface OAuthFlowResult {
  tokens: StoredTokens;
}

function resolveConfig(config: OAuthConfig) {
  const port = config.redirectPort ?? DEFAULT_REDIRECT_PORT;
  return {
    clientId: config.clientId,
    authorizationEndpoint: config.authorizationEndpoint ?? DEFAULT_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: config.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT,
    redirectUri: config.redirectUri ?? `http://127.0.0.1:${port}/auth/callback`,
    redirectPort: port,
    scope: config.scope ?? DEFAULT_SCOPE,
  };
}

export function getTokenEndpoint(config: OAuthConfig): string {
  return config.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
}

/**
 * Build the full authorization URL for the PKCE flow.
 */
export function buildAuthorizeUrl(
  config: OAuthConfig,
  state: string,
  codeChallenge: string
): string {
  const resolved = resolveConfig(config);

  const params = new URLSearchParams({
    client_id: resolved.clientId,
    redirect_uri: resolved.redirectUri,
    response_type: 'code',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    scope: resolved.scope,
  });

  return `${resolved.authorizationEndpoint}?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCodeForTokens(
  config: OAuthConfig,
  code: string,
  codeVerifier: string
): Promise<StoredTokens> {
  const resolved = resolveConfig(config);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: resolved.clientId,
    code,
    redirect_uri: resolved.redirectUri,
    code_verifier: codeVerifier,
  });

  const response = await fetch(resolved.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Token exchange failed (${response.status}).${text ? ` Response: ${text}` : ''}`
    );
  }

  const result = (await response.json()) as Record<string, unknown>;

  const accessToken = result['access_token'];
  if (typeof accessToken !== 'string') {
    throw new Error('Token response missing access_token');
  }

  const expiresIn = typeof result['expires_in'] === 'number' ? result['expires_in'] : 3600;
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

  return {
    access_token: accessToken,
    refresh_token: typeof result['refresh_token'] === 'string' ? result['refresh_token'] : undefined,
    expires_at: expiresAt,
    account_id: typeof result['account_id'] === 'string' ? result['account_id'] : undefined,
    scope: typeof result['scope'] === 'string' ? result['scope'] : undefined,
  };
}

/**
 * Run the full interactive PKCE OAuth flow.
 *
 * For local environments: opens a browser and starts a local HTTP callback server.
 * For headless environments: prints the URL and waits for manual paste of the redirect URL.
 */
export async function runOAuthFlow(
  config: OAuthConfig,
  options: {
    openExternalUrl?: (url: string) => Promise<boolean>;
    readCallbackUrl?: () => Promise<string>;
    timeoutMs?: number;
    tokenStore?: TokenStoreLocation | string;
  } = {}
): Promise<OAuthFlowResult> {
  const resolved = resolveConfig(config);
  const timeoutMs = options.timeoutMs ?? 300_000;

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const authorizeUrl = buildAuthorizeUrl(config, state, codeChallenge);

  let callbackResult: { code: string; returnedState: string };

  const didOpen = options.openExternalUrl
    ? await options.openExternalUrl(authorizeUrl)
    : false;

  if (didOpen) {
    // Local flow: start callback server.
    callbackResult = await waitForCallback(resolved.redirectPort, timeoutMs);
  } else {
    // Headless flow: print URL and wait for paste.
    console.log('\nOpen this URL in a browser to authenticate:\n');
    console.log(`  ${authorizeUrl}\n`);
    console.log('After authorizing, paste the full redirect URL here:\n');

    if (!options.readCallbackUrl) {
      throw new Error('Cannot read callback URL in this environment. Use --headless or provide readCallbackUrl.');
    }

    const pastedUrl = await options.readCallbackUrl();
    callbackResult = extractCallbackParams(pastedUrl);
  }

  // Validate state.
  if (callbackResult.returnedState !== state) {
    throw new Error('OAuth state mismatch — possible CSRF attack. Please try again.');
  }

  // Exchange code for tokens.
  const tokens = await exchangeCodeForTokens(config, callbackResult.code, codeVerifier);

  // Persist tokens.
  await writeTokens(tokens, options.tokenStore);

  return { tokens };
}

/**
 * Start a temporary local HTTP server to capture the OAuth callback.
 */
function waitForCallback(
  port: number,
  timeoutMs: number
): Promise<{ code: string; returnedState: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      if (reqUrl.pathname !== '/auth/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const code = reqUrl.searchParams.get('code');
      const returnedState = reqUrl.searchParams.get('state');
      const error = reqUrl.searchParams.get('error');

      if (error) {
        const description = reqUrl.searchParams.get('error_description') ?? error;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(buildHtmlResponse(false, `Authentication failed: ${description}`));
        cleanup();
        reject(new Error(`OAuth error: ${description}`));
        return;
      }

      if (!code || !returnedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(buildHtmlResponse(false, 'Missing code or state parameter.'));
        cleanup();
        reject(new Error('OAuth callback missing code or state'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(buildHtmlResponse(true, 'Authentication successful! You can close this tab.'));
      cleanup();
      resolve({ code, returnedState });
    });

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`OAuth callback timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      server.close();
    }

    server.listen(port, '127.0.0.1', () => {
      // Server ready, waiting for callback.
    });

    server.on('error', (err) => {
      cleanup();
      reject(new Error(`Failed to start OAuth callback server on port ${port}: ${err.message}`));
    });
  });
}

function extractCallbackParams(urlString: string): { code: string; returnedState: string } {
  const trimmed = urlString.trim();

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Invalid callback URL. Please paste the complete redirect URL.');
  }

  const code = parsed.searchParams.get('code');
  const returnedState = parsed.searchParams.get('state');

  if (!code) {
    throw new Error('Callback URL missing "code" parameter.');
  }

  if (!returnedState) {
    throw new Error('Callback URL missing "state" parameter.');
  }

  return { code, returnedState };
}

function buildHtmlResponse(success: boolean, message: string): string {
  const safeMessage = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const color = success ? '#22c55e' : '#ef4444';

  return `<!DOCTYPE html>
<html>
<head><title>Keygate Auth</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#fff;">
  <div style="text-align:center;">
    <h1 style="color:${color};">${success ? '&#10003;' : '&#10007;'}</h1>
    <p>${safeMessage}</p>
  </div>
</body>
</html>`;
}
