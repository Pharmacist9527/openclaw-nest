import Docker from "dockerode";
import { InstanceEngine } from "./interface.js";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";
import { PassThrough } from "node:stream";
import { getNestDir, getInstance, saveInstance, removeInstance, nextAvailablePort } from "../store.js";
import { generateConfig, writeInstanceConfig, readInstanceConfig, deepMerge, checkPort, validateInstanceName } from "../configure.js";

var IS_WIN = process.platform === "win32";
var CONTAINER_PREFIX = "oc-";
var OC_IMAGE = "pharmacist9527/openclaw-runtime:latest";

function getDocker() {
  if (IS_WIN) {
    return new Docker({ socketPath: "//./pipe/docker_engine" });
  }
  return new Docker({ socketPath: "/var/run/docker.sock" });
}

/**
 * Detect the Docker network that the Nest manager container is on.
 * When Nest runs inside Docker (via docker-compose), it's on a custom network
 * like "projectname_default", not the default "bridge" network.
 * Instance containers must join the same network for port checking to work.
 */
async function detectNestNetwork(docker) {
  var hostname = (await import("node:os")).hostname();
  try {
    var self = docker.getContainer(hostname);
    var info = await self.inspect();
    var networks = info.NetworkSettings.Networks;
    for (var netName of Object.keys(networks)) {
      if (netName !== "bridge" && networks[netName].IPAddress) {
        return netName;
      }
    }
  } catch { /* not in Docker, or can't detect */ }
  return null;
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
 * Check if a container's internal port is reachable.
 * When Nest runs inside Docker, we can't use localhost:hostPort.
 * Instead, get the container's IP on the bridge network and check the internal port.
 * Falls back to localhost:hostPort for non-Docker Nest environments.
 */
async function checkContainerPort(docker, containerId, internalPort, hostPort) {
  try {
    var info = await docker.getContainer(containerId).inspect();
    var networks = info.NetworkSettings.Networks;
    var ip = null;
    if (networks.bridge && networks.bridge.IPAddress) {
      ip = networks.bridge.IPAddress;
    } else {
      for (var netName of Object.keys(networks)) {
        if (networks[netName].IPAddress) {
          ip = networks[netName].IPAddress;
          break;
        }
      }
    }
    if (ip) {
      return checkPortAddr(ip, internalPort);
    }
  } catch { /* fallback */ }
  return checkPort(hostPort);
}

function checkPortAddr(host, port) {
  return new Promise(function(resolve) {
    var sock = createConnection({ host: host, port: port }, function() {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", function() { resolve(false); });
    sock.setTimeout(800, function() { sock.destroy(); resolve(false); });
  });
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
    // Don't set bind here — onboard validates config strictly.
    // bind will be set in the final config after onboard completes.
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

      // Ensure image exists (first pull may take a while for the pre-built image)
      onProgress(5, "Pulling runtime image...");
      var pullPct = 5;
      try {
        await new Promise(function(resolve, reject) {
          docker.pull(OC_IMAGE, function(err, stream) {
            if (err) return reject(err);
            docker.modem.followProgress(stream, function(err2) {
              if (err2) return reject(err2);
              resolve();
            }, function(event) {
              if (event.status) {
                if (pullPct < 20) pullPct++;
                onProgress(pullPct, event.status + (event.progress ? " " + event.progress : ""));
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
      // openclaw is pre-installed in the runtime image, so only onboard + start
      var container = await docker.createContainer({
        Image: OC_IMAGE,
        name: name,
        Cmd: ["sh", "-c",
          // Only run onboard if not yet done (marker file tracks completion)
          "if [ ! -f /root/.openclaw/.onboard-done ]; then " +
          "openclaw onboard --flow quickstart --accept-risk " +
          "--skip-skills --skip-channels --skip-ui --skip-health " +
          "--non-interactive --gateway-port 28789 && " +
          "touch /root/.openclaw/.onboard-done && " +
          "echo '=== NEST_ONBOARD_DONE ==='; " +
          "fi && " +
          "exec openclaw gateway run --port 28789 --bind lan --allow-unconfigured"
        ],
        ExposedPorts: { "28789/tcp": {} },
        HostConfig: {
          Binds: [hostDir + ":/root/.openclaw"],
          PortBindings: {
            "28789/tcp": [{ HostPort: String(port) }],
          },
          RestartPolicy: { Name: "" },
        },
        WorkingDir: "/root",
      });

      currentContainer = container;
      var containerId = container.id;

      // Connect instance container to Nest's network (for port checking)
      var nestNet = await detectNestNetwork(docker);
      if (nestNet) {
        try {
          var network = docker.getNetwork(nestNet);
          await network.connect({ Container: containerId });
        } catch { /* ignore — will fall back to host port check */ }
      }

      // Update metadata with container ID
      meta.containerId = containerId;
      saveInstance(instanceId, meta);

      onProgress(25, "Starting container...");
      await container.start();

      if (aborted) {
        try { await safeStop(container, { t: 2 }); } catch {}
        throw new Error("Aborted");
      }

      // Wait for onboard + gateway to be ready by polling the gateway port.
      // This is more reliable than parsing Docker multiplexed log streams.
      onProgress(30, "Waiting for onboard & gateway startup...");

      var pct = 30;
      var maxPct = 80;
      var STARTUP_TIMEOUT = 120; // seconds
      var gatewayReady = false;

      for (var waitSec = 0; waitSec < STARTUP_TIMEOUT; waitSec += 2) {
        if (aborted) throw new Error("Aborted");

        // Check if container is still running
        try {
          var cInfo = await container.inspect();
          if (!cInfo.State.Running) {
            throw new Error("Container exited unexpectedly during setup. Check logs for details.");
          }
        } catch (inspErr) {
          if (inspErr.message.indexOf("Container exited") !== -1) throw inspErr;
        }

        var up = await checkContainerPort(docker, containerId, 28789, port);
        if (up) { gatewayReady = true; break; }

        if (pct < maxPct) pct = Math.min(pct + 2, maxPct);
        onProgress(pct, "Starting up... (" + waitSec + "s)");
        await new Promise(function(r) { setTimeout(r, 2000); });
      }

      if (!gatewayReady) {
        throw new Error("Gateway did not start within " + STARTUP_TIMEOUT + "s. Check container logs.");
      }

      onProgress(82, "Gateway is up, applying final configuration...");

      if (aborted) {
        try { await safeStop(container, { t: 2 }); } catch {}
        throw new Error("Aborted");
      }

      // Apply final config (models, channels, plugins, gateway bind)
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

        if (!finalCfg.gateway) finalCfg.gateway = {};
        finalCfg.gateway.bind = "lan";
        finalCfg.gateway.mode = "remote";

        if (!finalCfg.plugins) finalCfg.plugins = {};
        if (!finalCfg.plugins.entries) finalCfg.plugins.entries = {};
        if (config.channel === "telegram") {
          finalCfg.plugins.entries.telegram = { enabled: true };
        } else if (config.channel === "feishu") {
          finalCfg.plugins.entries.feishu = { enabled: true };
        }

        writeInstanceConfig(dir, finalCfg);
      } catch (cfgErr) {
        onProgress(85, "Warning: config error: " + cfgErr.message);
      }

      // Restart container to pick up final config
      onProgress(88, "Restarting gateway...");
      try {
        await container.restart({ t: 5 });
      } catch (restartErr) {
        onProgress(88, "Warning: gateway restart: " + restartErr.message);
      }

      // Wait for gateway to come back up after restart
      onProgress(92, "Waiting for gateway restart...");
      var restartReady = false;
      for (var rs = 0; rs < 60; rs += 2) {
        if (aborted) throw new Error("Aborted");
        var up2 = await checkContainerPort(docker, containerId, 28789, port);
        if (up2) { restartReady = true; break; }
        onProgress(92 + Math.min(Math.floor(rs / 15), 6), "Restarting... (" + rs + "s)");
        await new Promise(function(r) { setTimeout(r, 2000); });
      }

      if (!restartReady) {
        throw new Error("Gateway did not restart within 2 minutes. Check logs.");
      }

      // Set restart policy now that deploy is truly successful
      try {
        await container.update({ RestartPolicy: { Name: "unless-stopped" } });
      } catch { /* ignore */ }

      meta.status = "running";
      saveInstance(instanceId, meta);

      onProgress(100, "Done — gateway is running");
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
    var docker = getDocker();
    return checkContainerPort(docker, meta.containerId || containerName(instanceId), 28789, meta.port);
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
