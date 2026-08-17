#!/usr/bin/env node
import {
  runZaraacoderCommand
} from "./chunk-HKJMS7DX.js";
import "./chunk-5Q7ELQ3Z.js";
import "./chunk-DI2OPTT7.js";

// bin/zaraacoder.ts
import { homedir } from "os";
import { join } from "path";
import { config as loadDotenv } from "dotenv";
loadDotenv({ quiet: true });
loadDotenv({ path: join(homedir(), ".zaraa", ".env"), quiet: true });
process.exit(await runZaraacoderCommand(process.argv.slice(2)));
