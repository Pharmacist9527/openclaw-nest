import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

var __dirname = dirname(fileURLToPath(import.meta.url));
export var INDEX_HTML = readFileSync(join(__dirname, "..", "public", "index.html"), "utf-8");
