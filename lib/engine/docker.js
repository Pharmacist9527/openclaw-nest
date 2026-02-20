import { InstanceEngine } from "./interface.js";

/**
 * DockerEngine - Manages OpenClaw instances as sibling Docker containers.
 * Requires dockerode. Will be fully implemented in Phase 2.
 */
export class DockerEngine extends InstanceEngine {
  get type() { return "docker"; }

  async create(instanceId, config) {
    throw new Error("DockerEngine not yet implemented. Use --engine=process for now.");
  }

  async start(instanceId) {
    throw new Error("DockerEngine not yet implemented.");
  }

  async stop(instanceId) {
    throw new Error("DockerEngine not yet implemented.");
  }

  async remove(instanceId) {
    throw new Error("DockerEngine not yet implemented.");
  }

  async status(instanceId) {
    return "unknown";
  }

  async logs(instanceId, opts) {
    return null;
  }

  async list() {
    return [];
  }

  async health(instanceId) {
    return false;
  }

  deployStream(instanceId, config, onProgress) {
    return {
      promise: Promise.reject(new Error("DockerEngine not yet implemented.")),
      abort: function() {},
    };
  }
}
