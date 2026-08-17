// src/integrations/notion-client.ts
import { Client } from "@notionhq/client";
var NotionClient = class {
  client;
  constructor(apiKey) {
    this.client = new Client({ auth: apiKey });
  }
  async searchPages(query, limit = 10) {
    const response = await this.client.search({
      query,
      filter: { property: "object", value: "page" },
      page_size: limit
    });
    return response.results.map((page) => {
      const properties = page.properties;
      let title = "";
      for (const prop of Object.values(properties)) {
        if (prop.type === "title") {
          const titleArray = prop.title;
          title = titleArray?.map((t) => t.plain_text).join("") ?? "";
          break;
        }
      }
      return {
        id: page.id,
        title,
        url: page.url,
        lastEdited: page.last_edited_time
      };
    });
  }
  async readPage(pageId) {
    const response = await this.client.blocks.children.list({
      block_id: pageId,
      page_size: 100
    });
    const lines = [];
    for (const block of response.results) {
      const blockType = block.type;
      const blockData = block[blockType];
      if (blockData?.rich_text) {
        const richText = blockData.rich_text;
        const text = richText.map((t) => t.plain_text).join("");
        if (text) {
          lines.push(text);
        }
      }
    }
    return lines.join("\n");
  }
  async createPage(parentId, title, content) {
    const blocks = content.split("\n").map((line) => ({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: { content: line }
          }
        ]
      }
    }));
    const response = await this.client.pages.create({
      parent: { page_id: parentId },
      properties: {
        title: {
          title: [
            {
              text: { content: title }
            }
          ]
        }
      },
      children: blocks
    });
    const page = response;
    return { id: page.id, url: page.url };
  }
  async listDatabases(limit = 10) {
    const response = await this.client.search({
      filter: { property: "object", value: "database" },
      page_size: limit
    });
    return response.results.map((db) => {
      const titleArray = db.title;
      const title = titleArray?.map((t) => t.plain_text).join("") ?? "";
      return {
        id: db.id,
        title
      };
    });
  }
  async queryDatabase(databaseId, limit = 20) {
    const response = await this.client.databases.query({
      database_id: databaseId,
      page_size: limit
    });
    return response.results.map((row) => {
      const properties = row.properties;
      const record = {};
      for (const [key, prop] of Object.entries(properties)) {
        record[key] = extractPropertyValue(prop);
      }
      return record;
    });
  }
};
function extractPropertyValue(prop) {
  switch (prop.type) {
    case "title": {
      const titleArray = prop.title;
      return titleArray?.map((t) => t.plain_text).join("") ?? "";
    }
    case "rich_text": {
      const richText = prop.rich_text;
      return richText?.map((t) => t.plain_text).join("") ?? "";
    }
    case "number": {
      const num = prop.number;
      return num !== null && num !== void 0 ? String(num) : "";
    }
    case "select": {
      const select = prop.select;
      return select?.name ?? "";
    }
    case "multi_select": {
      const multiSelect = prop.multi_select;
      return multiSelect?.map((s) => s.name).join(", ") ?? "";
    }
    case "date": {
      const date = prop.date;
      return date?.start ?? "";
    }
    case "checkbox": {
      return prop.checkbox ? "true" : "false";
    }
    case "url": {
      return prop.url ?? "";
    }
    case "email": {
      return prop.email ?? "";
    }
    case "status": {
      const status = prop.status;
      return status?.name ?? "";
    }
    default:
      return "";
  }
}

export {
  NotionClient
};
