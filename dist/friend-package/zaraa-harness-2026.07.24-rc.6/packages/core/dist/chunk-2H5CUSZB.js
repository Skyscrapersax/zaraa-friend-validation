// src/integrations/spotify-client.ts
var SpotifyClient = class {
  accessToken;
  refreshToken;
  clientId;
  clientSecret;
  baseUrl = "https://api.spotify.com/v1";
  constructor(config) {
    this.accessToken = config.accessToken;
    this.refreshToken = config.refreshToken;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
  }
  async request(path, method = "GET", body, isRetry = false) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3e4);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json"
        },
        body: body ? JSON.stringify(body) : void 0,
        signal: controller.signal
      });
      if (response.status === 401 && !isRetry) {
        await this.refreshAccessToken();
        return this.request(path, method, body, true);
      }
      if (response.status === 204) return null;
      if (!response.ok) {
        throw new Error(`Spotify API error: ${response.status}`);
      }
      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
  async refreshAccessToken() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15e3);
    try {
      const response = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`
        },
        body: `grant_type=refresh_token&refresh_token=${this.refreshToken}`,
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Spotify token refresh failed: ${response.status}`);
      }
      const data = await response.json();
      this.accessToken = data.access_token;
    } finally {
      clearTimeout(timeout);
    }
  }
  async getPlayback() {
    const data = await this.request("/me/player");
    if (!data) {
      return {
        isPlaying: false,
        track: null,
        progressMs: 0,
        deviceName: ""
      };
    }
    const item = data.item;
    const track = item ? {
      id: item.id,
      name: item.name,
      artist: item.artists.map((a) => a.name).join(", "),
      album: item.album.name,
      durationMs: item.duration_ms,
      uri: item.uri
    } : null;
    return {
      isPlaying: data.is_playing,
      track,
      progressMs: data.progress_ms ?? 0,
      deviceName: data.device?.name ?? ""
    };
  }
  async play() {
    await this.request("/me/player/play", "PUT");
  }
  async pause() {
    await this.request("/me/player/pause", "PUT");
  }
  async next() {
    await this.request("/me/player/next", "POST");
  }
  async previous() {
    await this.request("/me/player/previous", "POST");
  }
  async search(query, limit = 10) {
    const encoded = encodeURIComponent(query);
    const data = await this.request(
      `/search?type=track&q=${encoded}&limit=${limit}`
    );
    if (!data?.tracks?.items) return [];
    return data.tracks.items.map(
      (item) => ({
        id: item.id,
        name: item.name,
        artist: item.artists.map((a) => a.name).join(", "),
        album: item.album.name,
        durationMs: item.duration_ms,
        uri: item.uri
      })
    );
  }
  async queue(uri) {
    const encoded = encodeURIComponent(uri);
    await this.request(`/me/player/queue?uri=${encoded}`, "POST");
  }
};

export {
  SpotifyClient
};
