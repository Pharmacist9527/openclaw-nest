import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

var MIN_NODE_MAJOR = 22;
var IS_WIN = process.platform === "win32";
var IS_MAC = process.platform === "darwin";

function findNodePath() {
  try {
    execSync("node --version", { stdio: "pipe", shell: true });
    return "node";
  } catch {}

  var home = homedir();
  var candidates = [];

  if (IS_WIN) {
    candidates = [
      join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
      join(process.env.LOCALAPPDATA || "", "Programs", "nodejs", "node.exe"),
      "C:\\Program Files\\nodejs\\node.exe",
    ];
  } else if (IS_MAC) {
    candidates = [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      join(home, ".nvm/current/bin/node"),
      join(home, ".fnm/current/bin/node"),
    ];
  } else {
    candidates = [
      "/usr/bin/node",
      "/usr/local/bin/node",
      join(home, ".nvm/current/bin/node"),
      join(home, ".fnm/current/bin/node"),
      "/snap/node/current/bin/node",
    ];
  }

  var nvmDir = process.env.NVM_DIR || join(home, ".nvm");
  if (!IS_WIN && existsSync(join(nvmDir, "versions", "node"))) {
    try {
      var dirs = readdirSync(join(nvmDir, "versions", "node"))
        .filter(function(d) { return d.startsWith("v"); })
        .sort()
        .reverse();
      for (var d = 0; d < dirs.length; d++) {
        candidates.push(join(nvmDir, "versions", "node", dirs[d], "bin", "node"));
      }
    } catch {}
  }

  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i] && existsSync(candidates[i])) return candidates[i];
  }
  return null;
}

function ensureNodeInPath() {
  var nodePath = findNodePath();
  if (!nodePath || nodePath === "node") return;
  var nodeDir = nodePath.replace(/[/\\]node(\.exe)?$/i, "");
  if (process.env.PATH && process.env.PATH.indexOf(nodeDir) === -1) {
    process.env.PATH = nodeDir + (IS_WIN ? ";" : ":") + process.env.PATH;
  }
}

function checkNodeVersion() {
  var nodePath = findNodePath();
  if (!nodePath) {
    console.warn(
      "WARNING: Node.js is not installed or not in PATH.\n" +
      "OpenClaw CLI requires Node.js " + MIN_NODE_MAJOR + "+.\n" +
      "Continuing anyway, but things may not work.\n"
    );
    return;
  }

  try {
    var cmd = nodePath === "node" ? "node --version" : '"' + nodePath + '" --version';
    var output = execSync(cmd, { stdio: "pipe", shell: true }).toString().trim();
    var match = output.match(/^v(\d+)/);
    if (!match) {
      console.warn(
        "WARNING: Could not detect Node.js version.\n" +
        "OpenClaw CLI requires Node.js " + MIN_NODE_MAJOR + "+.\n"
      );
      return;
    }
    var major = parseInt(match[1], 10);
    if (major < MIN_NODE_MAJOR) {
      console.warn(
        "WARNING: Node.js " + output + " detected, but OpenClaw CLI requires Node.js " + MIN_NODE_MAJOR + "+.\n" +
        "Please upgrade: https://nodejs.org\n"
      );
    } else {
      console.log("Node.js " + output + " detected.");
    }
  } catch {
    console.warn("WARNING: Could not check Node.js version.\n");
  }
}

export async function checkAndInstallOpenclaw() {
  ensureNodeInPath();
  checkNodeVersion();

  try {
    execSync("openclaw --version", { stdio: "pipe", shell: true });
    console.log("OpenClaw is already installed.");
  } catch {
    console.log("Installing OpenClaw...");
    try {
      execSync("npm install -g openclaw@latest", {
        stdio: "inherit",
        shell: true,
        env: Object.assign({}, process.env, {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf",
          GIT_CONFIG_VALUE_0: "ssh://git@github.com/",
        }),
      });
      console.log("OpenClaw installed successfully.");
    } catch {
      var hint = IS_WIN
        ? "Try running this program as Administrator."
        : "Try: sudo npm install -g openclaw@latest";
      throw new Error("Failed to install OpenClaw.\n" + hint);
    }
  }
}
