import express from "express";
import { createServer } from "node:http";
import { platform } from "node:os";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { INDEX_HTML } from "./html.js";
import { signSession, verifySession, checkRateLimit, recordFailure, clearFailure } from "./auth.js";
import { MODEL_CATALOG, validateInstanceName } from "./configure.js";
import { getAllInstances, getInstance } from "./store.js";

// Safely embed JSON inside <script> tags
function safeStringify(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}

function parseCookie(headers, name) {
  var raw = headers.cookie;
  if (!raw) return "";
  var pairs = raw.split(";");
  for (var i = 0; i < pairs.length; i++) {
    var pair = pairs[i].trim();
    var eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return "";
}

/**
 * Build instances list with live status for the API.
 */
async function getInstancesList(engine) {
  var all = getAllInstances();
  var result = [];
  for (var id of Object.keys(all)) {
    var meta = all[id];
    var liveStatus = await engine.status(id);
    result.push({
      id: id,
      engine: meta.engine || engine.type,
      port: meta.port,
      status: liveStatus,
      config: meta.config || {},
      createdAt: meta.createdAt,
    });
  }
  return result;
}

export async function startNestServer(opts) {
  opts = opts || {};
  var serverMode = opts.serverMode || false;
  var token = opts.token || "";
  var configPort = opts.port || 0;
  var engine = opts.engine;

  var app = express();
  app.use(express.json());

  // --- Ticket store for SSE ---
  var ticketStore = new Map();
  var cleanupTimer = setInterval(function() {
    var now = Date.now();
    for (var entry of ticketStore) {
      if (entry[1].expiresAt < now) ticketStore.delete(entry[0]);
    }
  }, 60000);
  cleanupTimer.unref();

  // --- Auth routes (server mode only) ---
  if (serverMode) {
    app.post("/auth/login", function(req, res) {
      var ip = req.ip;
      if (!checkRateLimit(ip)) {
        res.status(429).json({ error: "Too many attempts. Try again later." });
        return;
      }
      if (!req.body || req.body.token !== token) {
        recordFailure(ip);
        res.status(401).json({ error: "Invalid token" });
        return;
      }
      clearFailure(ip);
      var cookie = signSession(token);
      res.setHeader("Set-Cookie",
        "session=" + cookie
        + "; HttpOnly"
        + "; SameSite=Strict"
        + "; Max-Age=" + (7 * 24 * 3600)
        + "; Path=/"
      );
      res.json({ success: true });
    });

    // Auth middleware
    app.use(function(req, res, next) {
      if (req.path === "/" && req.method === "GET") return next();
      var sessionCookie = parseCookie(req.headers, "session");
      if (!sessionCookie || !verifySession(sessionCookie, token)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      next();
    });
  }

  // --- Serve page with server-injected state ---
  app.get("/", async function(req, res) {
    if (serverMode) {
      var sessionCookie = parseCookie(req.headers, "session");
      if (!sessionCookie || !verifySession(sessionCookie, token)) {
        var html = INDEX_HTML.replace("<!--SERVER_STATE-->", "");
        res.type("html").send(html);
        return;
      }
    }
    var instances = await getInstancesList(engine);
    var initScript = "<script>window.__STATE__=" + safeStringify({
      instances: instances,
      models: MODEL_CATALOG,
      engineType: engine.type,
    }) + "</script>";
    var htmlFull = INDEX_HTML.replace("<!--SERVER_STATE-->", initScript);
    res.type("html").send(htmlFull);
  });

  // --- Instance API ---

  // List all instances
  app.get("/instances", async function(req, res) {
    res.json(await getInstancesList(engine));
  });

  // Get instance detail
  app.get("/instances/:id", async function(req, res) {
    var id = req.params.id;
    var meta = getInstance(id);
    if (!meta) { res.status(404).json({ error: "Instance not found" }); return; }
    var liveStatus = await engine.status(id);
    res.json({
      id: id,
      engine: meta.engine || engine.type,
      port: meta.port,
      status: liveStatus,
      config: meta.config || {},
      createdAt: meta.createdAt,
    });
  });

  // Create instance (prepare ticket for SSE deploy)
  app.post("/instances", function(req, res) {
    var body = req.body || {};
    if (!body.apiKey) {
      res.status(400).json({ error: "API Key required" });
      return;
    }
    var instanceId = (body.instanceId || "default").trim();
    try { validateInstanceName(instanceId); } catch (e) {
      res.status(400).json({ error: e.message }); return;
    }

    // Check existing
    var existing = getInstance(instanceId);
    if (existing) {
      res.status(409).json({ error: "Instance \"" + instanceId + "\" already exists" });
      return;
    }

    var ticketId = randomUUID();
    ticketStore.set(ticketId, {
      data: body,
      expiresAt: Date.now() + 60000,
    });
    res.json({ ticket: ticketId });
  });

  // SSE deploy stream
  app.get("/instances/:id/deploy-stream", async function(req, res) {
    var ticket = ticketStore.get(req.query.ticket);
    if (!ticket || ticket.expiresAt < Date.now()) {
      res.status(400).json({ error: "Invalid or expired ticket" });
      return;
    }
    ticketStore.delete(req.query.ticket);

    var data = ticket.data;
    var instanceId = req.params.id;
    var apiKey = (data.apiKey || "").trim();
    var modelId = (data.model || "claude-opus-4-6").trim();
    var channel = (data.channel || "telegram").trim();
    var botToken = (data.botToken || "").trim();
    var appId = (data.appId || "").trim();
    var appSecret = (data.appSecret || "").trim();

    if (!apiKey) { res.status(400).json({ error: "API Key required" }); return; }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    function sendProgress(pct, msg) {
      res.write("data: " + JSON.stringify({ percent: pct, message: msg }) + "\n\n");
    }

    sendProgress(5, "Creating instance directory...");

    // Create the instance in store first
    try {
      await engine.create(instanceId, {
        apiKey: apiKey,
        modelId: modelId,
        channel: channel,
        botToken: botToken,
        appId: appId,
        appSecret: appSecret,
      });
    } catch (err) {
      sendProgress(-1, err.message);
      res.write("data: " + JSON.stringify({ percent: -1, message: err.message, error: true }) + "\n\n");
      res.end();
      return;
    }

    sendProgress(10, "Configuration written...");

    // Run deploy stream (onboard + gateway start)
    var deployConfig = {
      apiKey: apiKey,
      modelId: modelId,
      channel: channel,
      botToken: botToken,
      appId: appId,
      appSecret: appSecret,
    };

    var handle = engine.deployStream(instanceId, deployConfig, sendProgress);

    req.on("close", function() { handle.abort(); });

    handle.promise
      .then(function(result) {
        res.write("data: " + JSON.stringify({ percent: 100, message: "Done", done: true, port: result.port }) + "\n\n");
        res.end();
      })
      .catch(function(err) {
        res.write("data: " + JSON.stringify({ percent: -1, message: err.message, error: true }) + "\n\n");
        res.end();
      });
  });

  // Start instance
  app.post("/instances/:id/start", async function(req, res) {
    try {
      await engine.start(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to start instance" });
    }
  });

  // Stop instance
  app.post("/instances/:id/stop", async function(req, res) {
    try {
      await engine.stop(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to stop instance" });
    }
  });

  // Restart instance
  app.post("/instances/:id/restart", async function(req, res) {
    try {
      await engine.stop(req.params.id);
      await engine.start(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to restart instance" });
    }
  });

  // Delete instance
  app.delete("/instances/:id", async function(req, res) {
    try {
      await engine.remove(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to delete instance" });
    }
  });

  // SSE logs stream
  app.get("/instances/:id/logs", async function(req, res) {
    var follow = req.query.follow === "true";
    var stream = await engine.logs(req.params.id, { tail: 200, follow: follow });
    if (!stream) {
      res.status(404).json({ error: "No logs available" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    stream.on("data", function(chunk) {
      var lines = chunk.toString().split("\n");
      for (var i = 0; i < lines.length; i++) {
        if (lines[i]) {
          res.write("data: " + JSON.stringify({ line: lines[i] }) + "\n\n");
        }
      }
    });

    stream.on("end", function() {
      res.write("data: " + JSON.stringify({ done: true }) + "\n\n");
      res.end();
    });

    req.on("close", function() {
      if (stream.destroy) stream.destroy();
    });
  });

  // Update config
  app.put("/instances/:id/config", async function(req, res) {
    var id = req.params.id;
    var meta = getInstance(id);
    if (!meta) { res.status(404).json({ error: "Instance not found" }); return; }

    // For now, support changing modelId
    var body = req.body || {};
    if (body.modelId) {
      var { MODEL_CATALOG: catalog, generateConfig: genCfg, writeInstanceConfig, readInstanceConfig, deepMerge } = await import("./configure.js");
      var model = catalog.find(function(m) { return m.id === body.modelId; });
      if (!model) { res.status(400).json({ error: "Unknown model: " + body.modelId }); return; }

      var { getNestDir } = await import("./store.js");
      var { join } = await import("node:path");
      var dir = join(getNestDir(), "instances", id);
      var existingCfg = readInstanceConfig(dir) || {};

      // Update model in config
      if (existingCfg.models && existingCfg.models.providers && existingCfg.models.providers.anthropic &&
          Array.isArray(existingCfg.models.providers.anthropic.models) && existingCfg.models.providers.anthropic.models.length > 0) {
        existingCfg.models.providers.anthropic.models[0].id = model.id;
        existingCfg.models.providers.anthropic.models[0].name = model.name;
      }
      if (!existingCfg.agents) existingCfg.agents = {};
      if (!existingCfg.agents.defaults) existingCfg.agents.defaults = {};
      if (!existingCfg.agents.defaults.model) existingCfg.agents.defaults.model = {};
      existingCfg.agents.defaults.model.primary = "anthropic/" + model.id;

      writeInstanceConfig(dir, existingCfg);

      // Update metadata
      var { saveInstance } = await import("./store.js");
      meta.config = meta.config || {};
      meta.config.modelId = body.modelId;
      saveInstance(id, meta);

      // Restart if running
      try { await engine.stop(id); await engine.start(id); } catch { /* ignore */ }
    }

    res.json({ success: true });
  });

  // Connect Telegram user to instance
  app.post("/instances/:id/connect-telegram", async function(req, res) {
    var id = req.params.id;
    var telegramId = (req.body && req.body.telegramId || "").trim();
    if (!telegramId) {
      res.status(400).json({ error: "Telegram User ID required" });
      return;
    }
    try {
      await engine.connectTelegramUser(id, telegramId);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message || "Failed to connect user" });
    }
  });

  // Engine info
  app.get("/engine/info", async function(req, res) {
    var info = { type: engine.type };
    if (engine.type === "docker" && engine.info) {
      try {
        info.docker = await engine.info();
      } catch { /* ignore */ }
    }
    res.json(info);
  });

  // Shutdown (local mode only)
  if (!serverMode) {
    var shutdownResolve;
    var shutdownPromise = new Promise(function(resolve) { shutdownResolve = resolve; });

    app.post("/shutdown", function(req, res) {
      res.json({ ok: true });
      console.log("\nShutting down...");
      server.close(function() { shutdownResolve(); });
    });
  }

  // --- Bind server ---
  var server = createServer(app);
  if (serverMode) {
    await new Promise(function(resolve) { server.listen(configPort, "0.0.0.0", resolve); });
    console.log("Nest ready: http://0.0.0.0:" + configPort);
  } else {
    await new Promise(function(resolve) { server.listen(0, "127.0.0.1", resolve); });
    var port = server.address().port;
    var url = "http://127.0.0.1:" + port;

    console.log("Nest ready: " + url);
    console.log("Opening browser...\n");

    var os = platform();
    try {
      if (os === "win32") {
        execSync('start "" "' + url + '"', { stdio: "ignore" });
      } else if (os === "darwin") {
        execSync('open "' + url + '"', { stdio: "ignore" });
      } else {
        execSync('xdg-open "' + url + '"', { stdio: "ignore" });
      }
    } catch {
      console.log("Could not open browser. Please visit: " + url);
    }
  }

  if (!serverMode) {
    return shutdownPromise;
  }

  return new Promise(function() {});
}
