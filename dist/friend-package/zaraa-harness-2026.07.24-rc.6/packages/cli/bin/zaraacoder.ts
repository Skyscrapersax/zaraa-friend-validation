#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { runZaraacoderCommand } from "../src/commands/zaraacoder.js";

loadDotenv({ quiet: true });
loadDotenv({ path: join(homedir(), ".zaraa", ".env"), quiet: true });

process.exit(await runZaraacoderCommand(process.argv.slice(2)));
