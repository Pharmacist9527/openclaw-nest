import { existsSync } from "node:fs";

/**
 * Detect the best engine to use.
 * Priority:
 * 1. CLI arg --engine=docker|process
 * 2. Environment variable NEST_ENGINE=docker|process
 * 3. Auto-detect Docker daemon connectivity
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
 * Check if Docker daemon is reachable by actually pinging it via dockerode.
 */
async function isDockerAvailable() {
  try {
    var Docker = (await import("dockerode")).default;
    var docker;
    if (process.platform === "win32") {
      docker = new Docker({ socketPath: "//./pipe/docker_engine" });
    } else {
      if (!existsSync("/var/run/docker.sock")) return false;
      docker = new Docker({ socketPath: "/var/run/docker.sock" });
    }
    await docker.ping();
    return true;
  } catch {
    return false;
  }
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
