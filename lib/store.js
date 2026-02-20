import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

var NEST_DIR = process.env.HOST_DATA_PATH || join(homedir(), ".openclaw-nest");
var STORE_FILE = join(NEST_DIR, "instances.json");

function ensureDir() {
  if (!existsSync(NEST_DIR)) mkdirSync(NEST_DIR, { recursive: true });
}

function loadRaw() {
  ensureDir();
  try {
    return JSON.parse(readFileSync(STORE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveRaw(data) {
  ensureDir();
  writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), "utf-8");
}

/** Get all instances metadata */
export function getAllInstances() {
  return loadRaw();
}

/** Get a single instance metadata, or null */
export function getInstance(id) {
  var all = loadRaw();
  return all[id] || null;
}

/** Save/update instance metadata */
export function saveInstance(id, meta) {
  var all = loadRaw();
  all[id] = meta;
  saveRaw(all);
}

/** Remove instance metadata */
export function removeInstance(id) {
  var all = loadRaw();
  delete all[id];
  saveRaw(all);
}

/** Get the next available port starting from BASE_PORT */
export function nextAvailablePort(basePort) {
  basePort = basePort || 18790;
  var all = loadRaw();
  var usedPorts = new Set();
  for (var key of Object.keys(all)) {
    if (all[key].port) usedPorts.add(all[key].port);
  }
  var port = basePort;
  while (usedPorts.has(port)) port++;
  return port;
}

/** Get the nest data directory */
export function getNestDir() {
  ensureDir();
  return NEST_DIR;
}
