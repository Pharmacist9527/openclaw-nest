import Docker from "dockerode";
import { InstanceEngine } from "./interface.js";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { getNestDir, getInstance, saveInstance, removeInstance, nextAvailablePort } from "../store.js";
import { generateConfig, writeInstanceConfig, readInstanceConfig, deepMerge, checkPort, validateInstanceName } from "../configure.js";

var IS_WIN = process.platform === "win32";
var CONTAINER_PREFIX = "oc-";
var OC_IMAGE = "node:22-slim";

function getDocker() {
  if (IS_WIN) {
    return new Docker({ socketPath: "//./pipe/docker_engine" });
  }
  return new Docker({ socketPath: "/var/run/docker.sock" });
}

/** Safely stop a container — ignores 304 "already stopped" and 404 "not found". */
async function safeStop(container, opts) {
  try {
    await container.stop(opts || {});
  } catch (err) {
    if (err.statusCode === 304 || err.statusCode === 404) return;
    throw err;
  }
}

/**
 * Resolve the host-side data path for bind mounts.
 * When Nest itself runs inside Docker, HOST_DATA_PATH must be set to
 * the absolute path on the Docker host so sibling container bind mounts
 * are correct.
 */
function hostDataPath() {
  return process.env.HOST_DATA_PATH || getNestDir();
}

function instanceDataDir(instanceId) {
  return join(getNestDir(), "instances", instanceId);
}

function hostInstanceDir(instanceId) {
  // Path on the host for Docker bind mount
  return join(hostDataPath(), "instances", instanceId).replace(/\\/g, "/");
}

function containerName(instanceId) {
  return CONTAINER_PREFIX + instanceId;
}

export class DockerEngine extends InstanceEngine {
  get type() { return "docker"; }

  async create(instanceId, config) {
    validateInstanceName(instanceId);

    var meta = getInstance(instanceId);
    if (meta) throw new Error("Instance \"" + instanceId + "\" already exists");

    var port = config.port || nextAvailablePort();
    var dir = instanceDataDir(instanceId);
    mkdirSync(dir, { recursive: true });

    // Generate and write openclaw config
    var channelCreds = {};
    if (config.channel === "telegram") channelCreds.botToken = config.botToken || "";
    else if (config.channel === "feishu") {
      channelCreds.appId = config.appId || "";
      channelCreds.appSecret = config.appSecret || "";
    }

    var ocConfig = generateConfig(config.apiKey, config.modelId, config.channel, channelCreds, port);

    // For Docker: gateway listens on 28789 inside container, mapped to host port
    ocConfig.gateway.port = 28789;
    writeInstanceConfig(dir, ocConfig);

    // Save metadata (port is host-side)
    saveInstance(instanceId, {
      id: instanceId,
      engine: "docker",
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
   * Deploy stream: install openclaw in container, run onboard, start gateway.
   */
  deployStream(instanceId, config, onProgress) {
    var aborted = false;
    var currentContainer = null;

    var promise = (async function() {
      var meta = getInstance(instanceId);
      if (!meta) throw new Error("Instance \"" + instanceId + "\" not found");

      var docker = getDocker();
      var port = meta.port;
      var dir = instanceDataDir(instanceId);
      var hostDir = hostInstanceDir(instanceId);
      var name = containerName(instanceId);

      // Ensure image exists
      onProgress(10, "Pulling image " + OC_IMAGE + "...");
      try {
        await new Promise(function(resolve, reject) {
          docker.pull(OC_IMAGE, function(err, stream) {
            if (err) return reject(err);
            docker.modem.followProgress(stream, function(err2) {
              if (err2) return reject(err2);
              resolve();
            }, function(event) {
              if (event.status) {
                onProgress(12, event.status + (event.progress ? " " + event.progress : ""));
              }
            });
          });
        });
      } catch (pullErr) {
        onProgress(12, "Warning: pull failed, trying local image: " + pullErr.message);
      }

      if (aborted) throw new Error("Aborted");

      // Remove old container if exists
      try {
        var old = docker.getContainer(name);
        var info = await old.inspect();
        if (info.State.Running) await safeStop(old, { t: 5 });
        await old.remove({ force: true });
      } catch { /* no old container */ }

      onProgress(20, "Creating container...");

      // Create container with openclaw state dir mounted
      var container = await docker.createContainer({
        Image: OC_IMAGE,
        name: name,
        Cmd: ["sh", "-c",
          // Smart entrypoint: skip install if openclaw already exists (container restart)
          "if ! command -v openclaw >/dev/null 2>&1; then " +
          "apt-get update && apt-get install -y --no-install-recommends git cmake make g++ ca-certificates && " +
          "npm install -g openclaw@latest && " +
          "openclaw onboard --flow quickstart --accept-risk " +
          "--skip-skills --skip-channels --skip-ui --skip-health " +
          "--non-interactive --gateway-port 28789 && " +
          "echo '=== NEST_ONBOARD_DONE ==='; " +
          "fi && " +
          "exec openclaw gateway run --port 28789"
        ],
        ExposedPorts: { "28789/tcp": {} },
        HostConfig: {
          Binds: [hostDir + ":/root/.openclaw"],
          PortBindings: {
            "28789/tcp": [{ HostPort: String(port) }],
          },
          RestartPolicy: { Name: "" },
        },
        Env: [
          "NODE_ENV=production",
          "GIT_CONFIG_COUNT=1",
          "GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf",
          "GIT_CONFIG_VALUE_0=ssh://git@github.com/",
        ],
        WorkingDir: "/root",
      });

      currentContainer = container;
      var containerId = container.id;

      // Update metadata with container ID
      meta.containerId = containerId;
      saveInstance(instanceId, meta);

      onProgress(25, "Starting container...");
      await container.start();

      if (aborted) {
        try { await safeStop(container, { t: 2 }); } catch {}
        throw new Error("Aborted");
      }

      // Follow container logs for progress
      onProgress(30, "Installing OpenClaw in container...");

      var logStream = await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        since: 0,
      });

      var pct = 30;
      var maxPct = 85;

      await new Promise(function(resolve, reject) {
        var resolved = false;

        function done(err) {
          if (resolved) return;
          resolved = true;
          logStream.removeAllListeners();
          if (logStream.destroy) logStream.destroy();
          if (err) reject(err);
          else resolve();
        }

        logStream.on("data", function(chunk) {
          // Docker multiplexed stream: first 8 bytes are header
          var text = chunk.toString("utf-8");
          var lines = text.split("\n");
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;

            if (pct < maxPct) {
              pct = Math.min(pct + 2, maxPct);
              var msg = line.length > 60 ? line.slice(0, 60) + "..." : line;
              onProgress(pct, msg);
            }

            // Detect onboard completion marker
            if (line.indexOf("NEST_ONBOARD_DONE") !== -1) {
              // Container is running, onboard done
              done(null);
              return;
            }
          }
        });

        logStream.on("end", function() { done(null); });
        logStream.on("error", function(err) { done(err); });

        // Timeout: if onboard doesn't finish in 3 minutes, proceed anyway
        setTimeout(function() { done(null); }, 180000);
      });

      if (aborted) {
        try { await safeStop(container, { t: 2 }); } catch {}
        throw new Error("Aborted");
      }

      // Apply final config
      onProgress(88, "Applying final configuration...");
      try {
        var channelCreds = {};
        if (config.channel === "telegram") channelCreds.botToken = config.botToken || "";
        else if (config.channel === "feishu") {
          channelCreds.appId = config.appId || "";
          channelCreds.appSecret = config.appSecret || "";
        }

        var generated = generateConfig(config.apiKey, config.modelId, config.channel, channelCreds, 28789);
        var postOnboard = readInstanceConfig(dir) || {};
        var finalCfg = deepMerge(postOnboard, generated);

        if (!finalCfg.plugins) finalCfg.plugins = {};
        if (!finalCfg.plugins.entries) finalCfg.plugins.entries = {};
        if (config.channel === "telegram") {
          finalCfg.plugins.entries.telegram = { enabled: true };
        } else if (config.channel === "feishu") {
          finalCfg.plugins.entries.feishu = { enabled: true };
        }

        writeInstanceConfig(dir, finalCfg);
      } catch (cfgErr) {
        onProgress(88, "Warning: config error: " + cfgErr.message);
      }

      // Restart container to pick up final config (gateway run is the main process)
      onProgress(93, "Restarting gateway...");
      try {
        await container.restart({ t: 5 });
      } catch (restartErr) {
        onProgress(93, "Warning: gateway restart: " + restartErr.message);
      }

      // Wait for port to become available
      onProgress(96, "Waiting for gateway...");
      var attempts = 0;
      while (attempts < 15) {
        var up = await checkPort(port);
        if (up) break;
        await new Promise(function(r) { setTimeout(r, 2000); });
        attempts++;
      }

      // Set restart policy now that deploy succeeded
      try {
        await container.update({ RestartPolicy: { Name: "unless-stopped" } });
      } catch { /* ignore */ }

      meta.status = "running";
      saveInstance(instanceId, meta);

      onProgress(100, "Done");
      return { port: port };
    })();

    return {
      promise: promise,
      abort: function() {
        aborted = true;
        if (currentContainer) {
          try { safeStop(currentContainer, { t: 2 }); } catch {}
        }
      },
    };
  }

  async start(instanceId) {
    var meta = getInstance(instanceId);
    if (!meta) throw new Error("Instance \"" + instanceId + "\" not found");

    var docker = getDocker();
    var name = containerName(instanceId);

    try {
      var container = docker.getContainer(meta.containerId || name);
      var info = await container.inspect();
      if (!info.State.Running) {
        await container.start();
      }
    } catch (err) {
      throw new Error("Failed to start container: " + err.message);
    }

    meta.status = "running";
    saveInstance(instanceId, meta);
  }

  async stop(instanceId) {
    var meta = getInstance(instanceId);
    if (!meta) throw new Error("Instance \"" + instanceId + "\" not found");

    var docker = getDocker();
    var name = containerName(instanceId);

    try {
      var container = docker.getContainer(meta.containerId || name);
      var info = await container.inspect();
      if (info.State.Running) {
        await safeStop(container, { t: 10 });
      }
    } catch { /* already stopped */ }

    meta.status = "stopped";
    saveInstance(instanceId, meta);
  }

  async remove(instanceId) {
    var meta = getInstance(instanceId);
    if (!meta) throw new Error("Instance \"" + instanceId + "\" not found");

    var docker = getDocker();
    var name = containerName(instanceId);

    try {
      var container = docker.getContainer(meta.containerId || name);
      try {
        var info = await container.inspect();
        if (info.State.Running) await safeStop(container, { t: 5 });
      } catch {}
      await container.remove({ force: true });
    } catch { /* container may not exist */ }

    // Remove data directory
    var dir = instanceDataDir(instanceId);
    if (existsSync(dir)) {
      var { rmSync } = await import("node:fs");
      rmSync(dir, { recursive: true, force: true });
    }

    removeInstance(instanceId);
  }

  async status(instanceId) {
    var meta = getInstance(instanceId);
    if (!meta) return "unknown";

    var docker = getDocker();
    var name = containerName(instanceId);

    try {
      var container = docker.getContainer(meta.containerId || name);
      var info = await container.inspect();
      var newStatus = info.State.Running ? "running" : "stopped";

      if (meta.status !== newStatus) {
        meta.status = newStatus;
        saveInstance(instanceId, meta);
      }
      return newStatus;
    } catch {
      // Container doesn't exist
      if (meta.status !== "stopped") {
        meta.status = "stopped";
        saveInstance(instanceId, meta);
      }
      return "stopped";
    }
  }

  async connectTelegramUser(instanceId, telegramId) {
    var dir = instanceDataDir(instanceId);
    var cfgPath = join(dir, "openclaw.json");
    if (!existsSync(cfgPath)) throw new Error("Config not found for instance: " + instanceId);

    var cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    if (!cfg.channels) cfg.channels = {};
    if (!cfg.channels.telegram) cfg.channels.telegram = {};
    cfg.channels.telegram.dmPolicy = "allowlist";

    var existing = (cfg.channels.telegram.allowFrom || []).map(String);
    if (!existing.includes(telegramId)) existing.push(telegramId);
    cfg.channels.telegram.allowFrom = existing;

    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");

    // Restart container to pick up config change
    var meta = getInstance(instanceId);
    if (meta && meta.containerId) {
      var docker = getDocker();
      try {
        var container = docker.getContainer(meta.containerId);
        await container.restart({ t: 5 });
      } catch { /* ignore */ }
    }
  }

  async logs(instanceId, opts) {
    var meta = getInstance(instanceId);
    if (!meta || !meta.containerId) return null;

    var docker = getDocker();
    try {
      var container = docker.getContainer(meta.containerId);
      var tail = (opts && opts.tail) || 200;
      var follow = (opts && opts.follow) || false;

      var logStream = await container.logs({
        follow: follow,
        stdout: true,
        stderr: true,
        tail: tail,
      });

      // dockerode returns a Buffer in non-follow mode, a stream in follow mode
      if (follow) {
        // Demux the multiplexed stream
        var passThrough = new PassThrough();
        container.modem.demuxStream(logStream, passThrough, passThrough);
        logStream.on("end", function() { passThrough.end(); });
        return passThrough;
      } else {
        // Non-follow: logStream is a Buffer
        var text = logStream.toString("utf-8");
        var { Readable } = await import("node:stream");
        return Readable.from([text]);
      }
    } catch {
      return null;
    }
  }

  async list() {
    var all = (await import("../store.js")).getAllInstances();
    return Object.keys(all).filter(function(id) {
      return all[id].engine === "docker";
    });
  }

  async health(instanceId) {
    var meta = getInstance(instanceId);
    if (!meta) return false;
    return checkPort(meta.port);
  }

  /** Get Docker daemon info */
  async info() {
    var docker = getDocker();
    var info = await docker.info();
    return {
      serverVersion: info.ServerVersion,
      os: info.OperatingSystem,
      containers: info.Containers,
      containersRunning: info.ContainersRunning,
    };
  }
}
