import { existsSync } from "node:fs";

/**
 * Detect the best engine to use.
 * Priority:
 * 1. CLI arg --engine=docker|process
 * 2. Environment variable NEST_ENGINE=docker|process
 * 3. Auto-detect Docker socket
 * 4. Fallback to process
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {Promise<"docker"|"process">}
 */
export async function detectEngine(argv) {
  // 1. CLI argument
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === "--engine" && argv[i + 1]) {
      var val = argv[i + 1].toLowerCase();
      if (val === "docker" || val === "process") return val;
    }
    if (argv[i].startsWith("--engine=")) {
      var val2 = argv[i].split("=")[1].toLowerCase();
      if (val2 === "docker" || val2 === "process") return val2;
    }
  }

  // 2. Environment variable
  var envEngine = (process.env.NEST_ENGINE || "").toLowerCase();
  if (envEngine === "docker" || envEngine === "process") return envEngine;

  // 3. Auto-detect Docker
  if (await isDockerAvailable()) return "docker";

  // 4. Fallback
  return "process";
}

/**
 * Check if Docker daemon is available.
 */
async function isDockerAvailable() {
  if (process.platform === "win32") {
    // Windows: named pipe
    return existsSync("//./pipe/docker_engine");
  }

  // Unix: socket file
  if (existsSync("/var/run/docker.sock")) {
    // Try a basic connectivity check
    try {
      var { createConnection } = await import("node:net");
      return new Promise(function(resolve) {
        var sock = createConnection({ path: "/var/run/docker.sock" }, function() {
          sock.write("GET /version HTTP/1.0\r\nHost: localhost\r\n\r\n");
        });
        var data = "";
        sock.on("data", function(d) { data += d.toString(); });
        sock.on("end", function() {
          resolve(data.indexOf("ApiVersion") !== -1);
        });
        sock.on("error", function() { resolve(false); });
        sock.setTimeout(2000, function() { sock.destroy(); resolve(false); });
      });
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Create the appropriate engine instance.
 * @param {"docker"|"process"} engineType
 * @returns {Promise<import("./interface.js").InstanceEngine>}
 */
export async function createEngine(engineType) {
  if (engineType === "docker") {
    var { DockerEngine } = await import("./docker.js");
    return new DockerEngine();
  }
  var { ProcessEngine } = await import("./process.js");
  return new ProcessEngine();
}
