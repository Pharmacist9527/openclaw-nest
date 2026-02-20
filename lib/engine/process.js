import { InstanceEngine } from "./interface.js";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { getNestDir, getInstance, saveInstance, removeInstance, nextAvailablePort } from "../store.js";
import { generateConfig, writeInstanceConfig, readInstanceConfig, deepMerge, checkPort, validateInstanceName } from "../configure.js";

var IS_WIN = process.platform === "win32";

function instanceDir(instanceId) {
  return join(getNestDir(), "instances", instanceId);
}

/** Build env with OPENCLAW_STATE_DIR pointing to instance dir. No --profile needed. */
function instanceEnv(instanceId) {
  return Object.assign({}, process.env, {
    OPENCLAW_STATE_DIR: instanceDir(instanceId),
  });
}

function execSafe(cmd, args, opts) {
  return execFileSync(cmd, args, Object.assign({ stdio: "ignore", timeout: 15000, shell: IS_WIN }, opts || {}));
}

export class ProcessEngine extends InstanceEngine {
  get type() { return "process"; }

  async create(instanceId, config) {
    validateInstanceName(instanceId);

    var meta = getInstance(instanceId);
    if (meta) throw new Error("Instance \"" + instanceId + "\" already exists");

    var port = config.port || nextAvailablePort();
    var dir = instanceDir(instanceId);
    mkdirSync(dir, { recursive: true });

    // Generate and write openclaw config
    var channelCreds = {};
    if (config.channel === "telegram") channelCreds.botToken = config.botToken || "";
    else if (config.channel === "feishu") {
      channelCreds.appId = config.appId || "";
      channelCreds.appSecret = config.appSecret || "";
    }

    var ocConfig = generateConfig(config.apiKey, config.modelId, config.channel, channelCreds, port);
    writeInstanceConfig(dir, ocConfig);

    // Save metadata
    saveInstance(instanceId, {
      id: instanceId,
      engine: "process",
      port: port,
      containerId: null,
      pid: null,
      config: {
        modelId: config.modelId,
        channel: config.channel,
      },
      createdAt: new Date().toISOString(),
      status: "stopped",
    });

    return { port: port };
  }

  /**
   * Run the full deploy stream (onboard + configure) with progress callbacks.
   * Returns { promise, abort }.
   */
  deployStream(instanceId, config, onProgress) {
    var child = null;
    var promise = new Promise(function(resolve, reject) {
      var meta = getInstance(instanceId);
      if (!meta) {
        return reject(new Error("Instance \"" + instanceId + "\" not found"));
      }

      var port = meta.port;
      var dir = instanceDir(instanceId);
      var env = instanceEnv(instanceId);

      onProgress(15, "Running onboarding...");
      var args = [
        "onboard", "--install-daemon", "--flow", "quickstart", "--accept-risk",
        "--skip-skills", "--skip-channels", "--skip-ui", "--skip-health",
        "--non-interactive", "--gateway-port", String(port)
      ];

      child = spawn("openclaw", args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: IS_WIN,
        env: env,
      });

      var pct = 15;
      var maxOnboard = 80;

      function tick(line) {
        if (pct < maxOnboard) {
          pct = Math.min(pct + 3, maxOnboard);
          var msg = line.length > 60 ? line.slice(0, 60) + "..." : line;
          onProgress(pct, msg || "Onboarding...");
        }
      }

      child.stdout.on("data", function(d) {
        d.toString().split("\n").forEach(function(l) { if (l.trim()) tick(l.trim()); });
      });
      child.stderr.on("data", function(d) {
        d.toString().split("\n").forEach(function(l) { if (l.trim()) tick(l.trim()); });
      });

      child.on("close", function(code) {
        if (code !== 0) {
          onProgress(pct, "Onboarding failed");
          return reject(new Error("Onboarding failed (exit " + code + ")"));
        }

        onProgress(85, "Applying final configuration...");
        try {
          var channelCreds = {};
          if (config.channel === "telegram") channelCreds.botToken = config.botToken || "";
          else if (config.channel === "feishu") {
            channelCreds.appId = config.appId || "";
            channelCreds.appSecret = config.appSecret || "";
          }

          var generated = generateConfig(config.apiKey, config.modelId, config.channel, channelCreds, port);
          var postOnboard = readInstanceConfig(dir) || {};
          var finalCfg = deepMerge(postOnboard, generated);

          // Fix plugin entries
          if (!finalCfg.plugins) finalCfg.plugins = {};
          if (!finalCfg.plugins.entries) finalCfg.plugins.entries = {};
          if (config.channel === "telegram") {
            finalCfg.plugins.entries.telegram = { enabled: true };
          } else if (config.channel === "feishu") {
            finalCfg.plugins.entries.feishu = { enabled: true };
          }

          writeInstanceConfig(dir, finalCfg);
        } catch (cfgErr) {
          onProgress(85, "Warning: failed to apply final config: " + cfgErr.message);
        }

        onProgress(92, "Restarting gateway...");
        try {
          execFileSync("openclaw", ["gateway", "restart"], {
            stdio: "ignore", timeout: 15000, shell: IS_WIN, env: env,
          });
        } catch (restartErr) {
          onProgress(92, "Warning: gateway restart failed: " + restartErr.message);
        }

        // Update metadata
        saveInstance(instanceId, Object.assign({}, meta, { status: "running" }));

        onProgress(100, "Done");
        resolve({ port: port });
      });

      child.on("error", function(err) {
        reject(new Error("Failed to start onboarding: " + err.message));
      });
    });

    return {
      promise: promise,
      abort: function() { if (child && !child.killed) child.kill(); },
    };
  }

  async start(instanceId) {
    var meta = getInstance(instanceId);
    if (!meta) throw new Error("Instance \"" + instanceId + "\" not found");

    execSafe("openclaw", ["gateway", "start", "--port", String(meta.port)], {
      env: instanceEnv(instanceId),
    });

    saveInstance(instanceId, Object.assign({}, meta, { status: "running" }));
  }

  async stop(instanceId) {
    var meta = getInstance(instanceId);
    if (!meta) throw new Error("Instance \"" + instanceId + "\" not found");

    try {
      execSafe("openclaw", ["gateway", "stop"], { env: instanceEnv(instanceId) });
    } catch { /* may already be stopped */ }

    saveInstance(instanceId, Object.assign({}, meta, { status: "stopped" }));
  }

  async remove(instanceId) {
    var meta = getInstance(instanceId);
    if (!meta) throw new Error("Instance \"" + instanceId + "\" not found");

    // Stop first
    try { await this.stop(instanceId); } catch { /* ignore */ }

    // Uninstall daemon
    try {
      execSafe("openclaw", ["gateway", "uninstall"], { env: instanceEnv(instanceId) });
    } catch { /* ignore */ }

    // Remove data directory
    var dir = instanceDir(instanceId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }

    // Remove metadata
    removeInstance(instanceId);
  }

  async status(instanceId) {
    var meta = getInstance(instanceId);
    if (!meta) return "unknown";

    var running = await checkPort(meta.port);
    var newStatus = running ? "running" : "stopped";

    // Sync status if changed
    if (meta.status !== newStatus) {
      saveInstance(instanceId, Object.assign({}, meta, { status: newStatus }));
    }

    return newStatus;
  }

  /**
   * Connect a Telegram user to an instance (add to allowlist).
   */
  async connectTelegramUser(instanceId, telegramId) {
    var dir = instanceDir(instanceId);
    var cfgPath = join(dir, "openclaw.json");
    if (!existsSync(cfgPath)) throw new Error("Config not found for instance: " + instanceId);

    var config = JSON.parse(readFileSync(cfgPath, "utf-8"));
    if (!config.channels) config.channels = {};
    if (!config.channels.telegram) config.channels.telegram = {};
    config.channels.telegram.dmPolicy = "allowlist";

    var existing = (config.channels.telegram.allowFrom || []).map(String);
    if (!existing.includes(telegramId)) existing.push(telegramId);
    config.channels.telegram.allowFrom = existing;

    writeFileSync(cfgPath, JSON.stringify(config, null, 2), "utf-8");

    // Restart gateway to apply
    try {
      execSafe("openclaw", ["gateway", "restart"], { env: instanceEnv(instanceId) });
    } catch { /* ignore */ }
  }

  async logs(instanceId, opts) {
    var meta = getInstance(instanceId);
    if (!meta) return null;

    var dir = instanceDir(instanceId);
    var logFile = join(dir, "gateway.log");
    if (!existsSync(logFile)) return null;

    try {
      var content = readFileSync(logFile, "utf-8");
      var lines = content.split("\n");
      var tail = (opts && opts.tail) || 100;
      var lastLines = lines.slice(-tail).join("\n");
      return Readable.from([lastLines]);
    } catch {
      return null;
    }
  }

  async list() {
    var { getAllInstances } = await import("../store.js");
    var all = getAllInstances();
    return Object.keys(all).filter(function(id) {
      return all[id].engine === "process";
    });
  }

  async health(instanceId) {
    var meta = getInstance(instanceId);
    if (!meta) return false;
    return checkPort(meta.port);
  }
}
