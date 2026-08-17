// src/integrations/spotify-tools.ts
var manifest = {
  name: "spotify",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["integration.spotify"],
  trust: "core",
  tools: [
    {
      name: "spotify_now_playing",
      description: "Get current Spotify playback status and track info",
      parameters: {
        type: "object",
        properties: {},
        required: []
      },
      requiresApproval: false
    },
    {
      name: "spotify_play",
      description: "Resume Spotify playback",
      parameters: {
        type: "object",
        properties: {},
        required: []
      },
      requiresApproval: false
    },
    {
      name: "spotify_pause",
      description: "Pause Spotify playback",
      parameters: {
        type: "object",
        properties: {},
        required: []
      },
      requiresApproval: false
    },
    {
      name: "spotify_next",
      description: "Skip to next track",
      parameters: {
        type: "object",
        properties: {},
        required: []
      },
      requiresApproval: false
    },
    {
      name: "spotify_previous",
      description: "Go back to previous track",
      parameters: {
        type: "object",
        properties: {},
        required: []
      },
      requiresApproval: false
    },
    {
      name: "spotify_search",
      description: "Search for tracks on Spotify",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query string"
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return (default: 10)"
          }
        },
        required: ["query"]
      },
      requiresApproval: false
    },
    {
      name: "spotify_queue",
      description: "Add a track to the playback queue",
      parameters: {
        type: "object",
        properties: {
          uri: {
            type: "string",
            description: "Spotify URI of the track to queue (e.g. spotify:track:xxx)"
          }
        },
        required: ["uri"]
      },
      requiresApproval: false
    }
  ]
};
function createHandlers(client) {
  return {
    spotify_now_playing: async (_args) => {
      const playback = await client.getPlayback();
      return JSON.stringify(playback);
    },
    spotify_play: async (_args) => {
      await client.play();
      return "Playback resumed";
    },
    spotify_pause: async (_args) => {
      await client.pause();
      return "Playback paused";
    },
    spotify_next: async (_args) => {
      await client.next();
      return "Skipped to next track";
    },
    spotify_previous: async (_args) => {
      await client.previous();
      return "Went back to previous track";
    },
    spotify_search: async (args) => {
      const query = args.query;
      if (!query) throw new Error("query is required");
      const limit = args.limit;
      const tracks = await client.search(query, limit);
      return JSON.stringify(tracks);
    },
    spotify_queue: async (args) => {
      const uri = args.uri;
      if (!uri) throw new Error("uri is required");
      await client.queue(uri);
      return `Added to queue: ${uri}`;
    }
  };
}

export {
  manifest,
  createHandlers
};
