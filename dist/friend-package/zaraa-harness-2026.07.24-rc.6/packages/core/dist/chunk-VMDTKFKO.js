// src/providers/openai-token-manager.ts
import { writeFile as writeFile2, mkdir as mkdir2 } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, dirname as dirname2 } from "path";
import { randomBytes, createHash } from "crypto";
import { createServer } from "http";

// src/providers/oauth-token-store.ts
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname } from "path";
function decodeExp(jwt) {
  const parts = jwt.split(".");
  if (parts.length !== 3) return 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return typeof payload?.exp === "number" ? payload.exp : 0;
  } catch {
    return 0;
  }
}
async function readAuthFileSafe(path) {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const tokens = parsed.tokens;
    if (!tokens || typeof tokens !== "object") return null;
    const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : null;
    if (!accessToken) return null;
    return {
      ...parsed,
      tokens: {
        access_token: accessToken,
        refresh_token: typeof tokens.refresh_token === "string" ? tokens.refresh_token : "",
        id_token: typeof tokens.id_token === "string" ? tokens.id_token : "",
        account_id: typeof tokens.account_id === "string" ? tokens.account_id : ""
      },
      last_refresh: typeof parsed.last_refresh === "string" ? parsed.last_refresh : (/* @__PURE__ */ new Date()).toISOString()
    };
  } catch {
    return null;
  }
}
function readAuthFileLoose(path) {
  return readFile(path, "utf-8").then((raw) => {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }).catch(() => ({}));
}
async function writeTokenFile(path, payload) {
  const existing = await readAuthFileLoose(path);
  const preservedTokens = typeof existing.tokens === "object" && existing.tokens !== null ? existing.tokens : {};
  const merged = {
    ...existing,
    tokens: {
      ...preservedTokens,
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      id_token: payload.id_token,
      account_id: payload.account_id
    },
    last_refresh: payload.last_refresh
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(merged, null, 2));
}
async function writeRotatedToAll(primaryPath, peerPath, payload) {
  const paths = primaryPath === peerPath ? [primaryPath] : [primaryPath, peerPath];
  await Promise.all(paths.map((path) => writeTokenFile(path, payload)));
}
function pickFreshestValid(local, peer, nowSeconds, expiryBufferSeconds = 60) {
  const localExp = decodeExp(local?.tokens?.access_token ?? "");
  const peerExp = decodeExp(peer?.tokens?.access_token ?? "");
  const localValid = localExp > nowSeconds + expiryBufferSeconds;
  const peerValid = peerExp > nowSeconds + expiryBufferSeconds;
  if (!localValid && !peerValid) return null;
  if (peerValid && (!localValid || peerExp > localExp)) return { source: "peer", auth: peer };
  return { source: local ? "local" : "peer", auth: local };
}

// src/providers/openai-token-manager.ts
var AUTH_URL = "https://auth.openai.com/authorize";
var TOKEN_URL = "https://auth.openai.com/oauth/token";
var DEFAULT_OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
var EXPIRY_BUFFER_S = 60;
var CALLBACK_PORT = 9876;
var DEFAULT_OPENAI_OAUTH_SCOPES = "openid profile email offline_access model.request";
var REALTIME_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
function getOpenAIOAuthClientId() {
  const envClientId = process.env.OPENAI_OAUTH_CLIENT_ID?.trim();
  return envClientId && envClientId.length > 0 ? envClientId : DEFAULT_OPENAI_OAUTH_CLIENT_ID;
}
function normalizeOAuthScopes(raw) {
  return raw.split(/[,\s]+/).map((scope) => scope.trim()).filter(Boolean);
}
function getOpenAIAuthScopes() {
  const envScopes = process.env.OPENAI_OAUTH_SCOPES?.trim();
  const scopes = new Set(normalizeOAuthScopes(envScopes || DEFAULT_OPENAI_OAUTH_SCOPES));
  scopes.add("model.request");
  return [...scopes].join(" ");
}
function decodeJwtPayload(jwt) {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch {
    return null;
  }
}
function getDefaultOpenAIAuthFilePath() {
  return join(homedir(), ".zaraa", "openai-auth.json");
}
function hasOpenAISessionAuth(authFilePath) {
  const path = authFilePath ?? getDefaultOpenAIAuthFilePath();
  try {
    if (!existsSync(path)) return false;
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed.tokens?.access_token === "string" && parsed.tokens.access_token.length > 0;
  } catch {
    return false;
  }
}
function getJwtScopes(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.scp)) return payload.scp;
  if (typeof payload.scp === "string") return payload.scp.split(/\s+/).filter(Boolean);
  if (typeof payload.scope === "string") return payload.scope.split(/\s+/).filter(Boolean);
  return [];
}
var OPENAI_MODEL_SCOPES = [
  "model.request",
  "api.responses.",
  "api.chat.",
  "api.chat_completions.",
  "api.completions.",
  "api.assistants.",
  "api.model.",
  "api.connectors.invoke"
];
function hasModelRequestScope(scopes) {
  return scopes.some((scope) => OPENAI_MODEL_SCOPES.some((prefix) => scope === prefix || scope.startsWith(prefix)));
}
function hasOpenAISessionModelAccess(authFilePath) {
  const path = authFilePath ?? getDefaultOpenAIAuthFilePath();
  try {
    if (!existsSync(path)) return false;
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    const accessToken = parsed.tokens?.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) return false;
    const scopes = getJwtScopes(decodeJwtPayload(accessToken));
    return hasModelRequestScope(scopes);
  } catch {
    return false;
  }
}
var OpenAITokenManager = class {
  authFilePath;
  peerAuthFilePath;
  cachedToken = null;
  cachedExp = 0;
  refreshPromise = null;
  constructor(authFilePath, peerAuthFilePath) {
    this.authFilePath = authFilePath ?? getDefaultOpenAIAuthFilePath();
    this.peerAuthFilePath = peerAuthFilePath ?? join(homedir(), ".codex", "auth.json");
  }
  get filePath() {
    return this.authFilePath;
  }
  /**
   * Import tokens from an existing Codex auth file (~/.codex/auth.json).
   * Returns true if tokens were found and imported.
   */
  async importFromCodex() {
    try {
      const codex = await readAuthFileSafe(this.peerAuthFilePath);
      if (!codex?.tokens?.access_token) return false;
      const now = Math.floor(Date.now() / 1e3);
      if (decodeExp(codex.tokens.access_token) <= now) return false;
      const authFile = {
        auth_mode: "oauth",
        tokens: {
          access_token: codex.tokens.access_token,
          refresh_token: codex.tokens.refresh_token,
          id_token: codex.tokens.id_token,
          account_id: codex.tokens.account_id
        },
        last_refresh: codex.last_refresh
      };
      await this.writeOwnAuthFile(authFile);
      this.cachedToken = codex.tokens.access_token;
      this.cachedExp = decodeExp(codex.tokens.access_token);
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Start the OAuth PKCE login flow.
   * Returns the authorization URL to open in a browser and starts a local
   * callback server to receive the auth code.
   */
  async startLogin() {
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const callbackUrl = `http://localhost:${CALLBACK_PORT}/callback`;
    const params = new URLSearchParams({
      client_id: getOpenAIOAuthClientId(),
      response_type: "code",
      redirect_uri: callbackUrl,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      scope: getOpenAIAuthScopes(),
      audience: "https://api.openai.com/v1"
    });
    const authUrl = `${AUTH_URL}?${params.toString()}`;
    const complete = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        server.close();
        reject(new Error("OAuth login timed out after 5 minutes"));
      }, 3e5);
      const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", `http://localhost:${CALLBACK_PORT}`);
        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(errorPage(error, url.searchParams.get("error_description") || ""));
          clearTimeout(timeout);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(errorPage("missing_code", "No authorization code received"));
          clearTimeout(timeout);
          server.close();
          reject(new Error("No authorization code received"));
          return;
        }
        try {
          await this.exchangeCode(code, codeVerifier, callbackUrl);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(successPage());
          clearTimeout(timeout);
          server.close();
          resolve();
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(errorPage("exchange_failed", err instanceof Error ? err.message : "Token exchange failed"));
          clearTimeout(timeout);
          server.close();
          reject(err);
        }
      });
      server.listen(CALLBACK_PORT, "127.0.0.1");
    });
    return { authUrl, complete };
  }
  /**
   * Exchange an authorization code for tokens directly (used by gateway callback).
   */
  async exchangeCodeDirect(code, redirectUri) {
    await this.exchangeCode(code, void 0, redirectUri);
  }
  async forceRefresh() {
    this.cachedToken = null;
    this.cachedExp = 0;
    return this.getAccessToken();
  }
  /**
   * Mint a short-lived ephemeral client secret (`ek_…`) for the Realtime API
   * using the subscription OAuth token. Works for both realtime conversation
   * sessions (`{ type: "realtime", model: "gpt-realtime" }`) and Whisper-grade
   * transcription sessions (`{ type: "transcription", … }`) — both are entitled
   * under the ChatGPT subscription, unlike the platform `/v1/audio/*` REST
   * endpoints which require a funded platform account.
   *
   * The returned `value` is browser-safe and expires in minutes; mint one per
   * client session and hand it to the WebRTC/WebSocket client.
   */
  async mintRealtimeSecret(session) {
    const attempt = (token2) => fetch(REALTIME_CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token2}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ session })
    });
    let token = await this.getAccessToken();
    let response = await attempt(token);
    if (response.status === 401 || response.status === 403) {
      token = await this.forceRefresh();
      response = await attempt(token);
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Realtime client_secret mint failed: ${response.status} ${errText}`);
    }
    return await response.json();
  }
  async getAccessToken() {
    const now = Math.floor(Date.now() / 1e3);
    if (this.cachedToken && this.cachedExp > now + EXPIRY_BUFFER_S) {
      return this.cachedToken;
    }
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.loadAndRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }
  async getAuthStatus() {
    try {
      const auth = await this.readAuthFile();
      const payload = decodeJwtPayload(auth.tokens.access_token);
      const now = Math.floor(Date.now() / 1e3);
      const expiresInSeconds = payload?.exp ? payload.exp - now : void 0;
      const peerAuth = await readAuthFileSafe(this.peerAuthFilePath);
      const peerIsValid = peerAuth ? decodeExp(peerAuth.tokens.access_token) > now + EXPIRY_BUFFER_S : false;
      return {
        authenticated: true,
        accountId: auth.tokens.account_id,
        expiresAt: payload?.exp ? new Date(payload.exp * 1e3).toISOString() : void 0,
        lastRefresh: auth.last_refresh,
        expiresInSeconds,
        stale: typeof expiresInSeconds === "number" ? expiresInSeconds < 86400 : void 0,
        needsReauth: typeof expiresInSeconds === "number" ? expiresInSeconds <= 0 && !peerIsValid : false
      };
    } catch {
      return { authenticated: false };
    }
  }
  async logout() {
    this.cachedToken = null;
    this.cachedExp = 0;
    try {
      const { unlink } = await import("fs/promises");
      await unlink(this.authFilePath);
    } catch {
    }
  }
  async exchangeCode(code, codeVerifier, redirectUri) {
    const body = {
      grant_type: "authorization_code",
      code,
      client_id: getOpenAIOAuthClientId()
    };
    if (codeVerifier) body.code_verifier = codeVerifier;
    if (redirectUri) body.redirect_uri = redirectUri;
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body)
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Token exchange failed: ${response.status} ${errText}`);
    }
    const tokens = await response.json();
    const payload = decodeJwtPayload(tokens.id_token || tokens.access_token);
    const authFile = {
      auth_mode: "oauth",
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        id_token: tokens.id_token,
        account_id: payload?.sub || ""
      },
      last_refresh: (/* @__PURE__ */ new Date()).toISOString()
    };
    await mkdir2(dirname2(this.authFilePath), { recursive: true });
    await writeFile2(this.authFilePath, JSON.stringify(authFile, null, 2));
    this.cachedToken = tokens.access_token;
    this.cachedExp = decodeJwtPayload(tokens.access_token)?.exp ?? 0;
  }
  async loadAndRefresh() {
    const auth = await this.readAuthFile();
    const peerAuth = await readAuthFileSafe(this.peerAuthFilePath);
    const token = auth.tokens.access_token;
    const exp = decodeExp(token);
    const now = Math.floor(Date.now() / 1e3);
    const freshest = pickFreshestValid(auth, peerAuth, now, EXPIRY_BUFFER_S);
    if (freshest && freshest.source === "peer") {
      await this.writeOwnAuthFile(freshest.auth);
      this.cachedToken = freshest.auth.tokens.access_token;
      this.cachedExp = decodeExp(freshest.auth.tokens.access_token);
      return freshest.auth.tokens.access_token;
    }
    if (exp > now + EXPIRY_BUFFER_S) {
      this.cachedToken = token;
      this.cachedExp = decodeExp(token);
      return token;
    }
    try {
      const refreshed = await this.refreshToken(auth.tokens.refresh_token);
      const payload = decodeJwtPayload(refreshed.id_token || refreshed.access_token);
      const newAuth = {
        ...auth,
        tokens: {
          ...auth.tokens,
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token,
          id_token: refreshed.id_token,
          account_id: payload?.sub || auth.tokens.account_id
        },
        last_refresh: (/* @__PURE__ */ new Date()).toISOString()
      };
      await writeRotatedToAll(this.authFilePath, this.peerAuthFilePath, {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        id_token: refreshed.id_token,
        account_id: payload?.sub || auth.tokens.account_id,
        last_refresh: newAuth.last_refresh
      });
      const newExp = decodeExp(refreshed.access_token);
      this.cachedToken = refreshed.access_token;
      this.cachedExp = newExp;
      return refreshed.access_token;
    } catch {
      const fallback = await this.readAuthFile({ ignoreMissingRefresh: true }).catch(() => null);
      const fallbackPeer = await readAuthFileSafe(this.peerAuthFilePath);
      const fallbackFresh = pickFreshestValid(fallback, fallbackPeer, now, EXPIRY_BUFFER_S);
      if (fallbackFresh) {
        await this.writeOwnAuthFile(fallbackFresh.auth);
        this.cachedToken = fallbackFresh.auth.tokens.access_token;
        this.cachedExp = decodeExp(fallbackFresh.auth.tokens.access_token);
        return fallbackFresh.auth.tokens.access_token;
      }
      throw new Error(
        "OpenAI auth expired \u2014 run `zaraa openai-login` or visit /api/auth/openai/login to re-authenticate"
      );
    }
  }
  async writeOwnAuthFile(auth) {
    const existing = await readAuthFileSafe(this.authFilePath);
    const updated = {
      ...existing,
      ...auth,
      tokens: {
        ...existing?.tokens,
        ...auth.tokens
      }
    };
    await mkdir2(dirname2(this.authFilePath), { recursive: true });
    await writeFile2(this.authFilePath, JSON.stringify(updated, null, 2));
  }
  async refreshToken(refreshToken) {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: getOpenAIOAuthClientId()
      })
    });
    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status}`);
    }
    return await response.json();
  }
  async readAuthFile(options = {}) {
    const auth = await readAuthFileSafe(this.authFilePath);
    if (auth) {
      return auth;
    }
    if (options.ignoreMissingRefresh) {
      return null;
    }
    throw new Error("OpenAI not authenticated \u2014 visit /api/auth/openai/login or run `zaraa openai-login`");
  }
};
function successPage() {
  return `<!DOCTYPE html>
<html>
<head><title>Zaraa \u2014 OpenAI Connected</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.card{text-align:center;padding:2rem;border-radius:12px;background:#1a1a1a;border:1px solid #333}
h1{color:#10b981;margin-bottom:.5rem}p{color:#999}</style></head>
<body><div class="card"><h1>Connected</h1><p>OpenAI authenticated successfully. You can close this tab.</p></div></body>
</html>`;
}
function errorPage(error, description) {
  return `<!DOCTYPE html>
<html>
<head><title>Zaraa \u2014 OpenAI Auth Error</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.card{text-align:center;padding:2rem;border-radius:12px;background:#1a1a1a;border:1px solid #333}
h1{color:#ef4444;margin-bottom:.5rem}p{color:#999}code{color:#fbbf24}</style></head>
<body><div class="card"><h1>Auth Error</h1><p><code>${error}</code></p><p>${description}</p></div></body>
</html>`;
}

export {
  decodeExp,
  readAuthFileSafe,
  writeRotatedToAll,
  pickFreshestValid,
  getDefaultOpenAIAuthFilePath,
  hasOpenAISessionAuth,
  hasOpenAISessionModelAccess,
  OpenAITokenManager
};
