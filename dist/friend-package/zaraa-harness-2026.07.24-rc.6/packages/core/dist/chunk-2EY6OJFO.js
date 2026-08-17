// src/messaging/discord-client.ts
import { Client as DiscordBot, Intents } from "oceanic.js";
var DiscordClient = class {
  bot;
  textHandlerRegistered = false;
  constructor(token) {
    this.bot = new DiscordBot({
      auth: `Bot ${token}`,
      gateway: {
        intents: Intents.GUILDS | Intents.GUILD_MESSAGES | Intents.MESSAGE_CONTENT
      }
    });
  }
  onText(handler) {
    if (this.textHandlerRegistered) return;
    this.textHandlerRegistered = true;
    this.bot.on("messageCreate", (message) => {
      if (message.author.bot) return;
      handler({
        messageId: message.id,
        channelId: message.channelID,
        guildId: message.guildID ?? "",
        text: message.content,
        authorId: message.author.id,
        authorName: message.author.username,
        date: message.timestamp.toISOString(),
        isBot: false
      });
    });
  }
  async send(channelId, text) {
    const msg = await this.bot.rest.channels.createMessage(channelId, { content: text });
    return { messageId: msg.id };
  }
  async start() {
    await this.bot.connect();
  }
  stop() {
    this.bot.disconnect(false);
  }
};

export {
  DiscordClient
};
