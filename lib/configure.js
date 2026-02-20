import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

export function validateInstanceName(name) {
  if (!name || name === "default") return;
  if (name.length > 32) throw new Error("Instance name too long (max 32 characters)");
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Instance name can only contain letters, numbers, hyphens and underscores");
}

export var MODEL_CATALOG = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", api: "anthropic-messages" },
  { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5", api: "anthropic-messages" },
  { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", api: "anthropic-messages" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", api: "anthropic-messages" },
  { id: "claude-opus-4-1-20250805", name: "Claude Opus 4.1", api: "anthropic-messages" },
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", api: "anthropic-messages" },
];

export function checkPort(port) {
  return new Promise(function(resolve) {
    var sock = createConnection({ host: "127.0.0.1", port: port }, function() {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", function() { resolve(false); });
    sock.setTimeout(800, function() { sock.destroy(); resolve(false); });
  });
}

export function generateConfig(apiKey, modelId, channel, channelCreds, port) {
  var model = MODEL_CATALOG.find(function(m) { return m.id === modelId; }) || MODEL_CATALOG[0];
  var config = {
    models: {
      providers: {
        anthropic: {
          api: "anthropic-messages",
          baseUrl: "https://direct.evolink.ai",
          apiKey: apiKey,
          models: [
            {
              id: model.id,
              name: model.name,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 8192,
            },
          ],
        },
      },
    },
    agents: {
      defaults: {
        model: {
          primary: "anthropic/" + model.id,
        },
      },
    },
    gateway: {
      port: port,
    },
  };

  // Channel-specific config
  if (channel === "telegram") {
    config.channels = {
      telegram: {
        enabled: true,
        botToken: channelCreds.botToken,
        dmPolicy: "pairing",
        groups: { "*": { requireMention: true } },
      },
    };
  } else if (channel === "feishu") {
    config.channels = {
      feishu: {
        enabled: true,
        dmPolicy: "pairing",
        groupPolicy: "open",
        requireMention: true,
        accounts: {
          main: {
            appId: channelCreds.appId,
            appSecret: channelCreds.appSecret,
          },
        },
      },
    };
  }

  return config;
}

export function deepMerge(target, source) {
  var result = Object.assign({}, target);
  for (var key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Write openclaw config to a directory.
 * @param {string} dir - Instance data directory
 * @param {object} configData - openclaw.json content
 */
export function writeInstanceConfig(dir, configData) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  var cfgPath = join(dir, "openclaw.json");

  var existing = {};
  if (existsSync(cfgPath)) {
    try { existing = JSON.parse(readFileSync(cfgPath, "utf-8")); } catch { /* fresh start */ }
  }

  var merged = deepMerge(existing, configData);
  writeFileSync(cfgPath, JSON.stringify(merged, null, 2), "utf-8");
  return cfgPath;
}

/**
 * Read openclaw config from a directory.
 * @param {string} dir - Instance data directory
 * @returns {object|null}
 */
export function readInstanceConfig(dir) {
  var cfgPath = join(dir, "openclaw.json");
  try {
    return JSON.parse(readFileSync(cfgPath, "utf-8"));
  } catch {
    return null;
  }
}
