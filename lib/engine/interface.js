/**
 * InstanceEngine - Abstract interface for instance lifecycle management.
 * Both DockerEngine and ProcessEngine implement these methods.
 */
export class InstanceEngine {
  /**
   * Create a new instance with the given config.
   * @param {string} instanceId
   * @param {object} config - { apiKey, modelId, channel, channelCreds, port }
   * @returns {Promise<{ port: number }>}
   */
  async create(instanceId, config) {
    throw new Error("Not implemented: create");
  }

  /**
   * Start an existing instance.
   * @param {string} instanceId
   * @returns {Promise<void>}
   */
  async start(instanceId) {
    throw new Error("Not implemented: start");
  }

  /**
   * Stop a running instance.
   * @param {string} instanceId
   * @returns {Promise<void>}
   */
  async stop(instanceId) {
    throw new Error("Not implemented: stop");
  }

  /**
   * Remove an instance and its data.
   * @param {string} instanceId
   * @returns {Promise<void>}
   */
  async remove(instanceId) {
    throw new Error("Not implemented: remove");
  }

  /**
   * Get instance status.
   * @param {string} instanceId
   * @returns {Promise<"running"|"stopped"|"error"|"unknown">}
   */
  async status(instanceId) {
    throw new Error("Not implemented: status");
  }

  /**
   * Get a readable log stream for the instance.
   * @param {string} instanceId
   * @param {object} opts - { tail, follow }
   * @returns {Promise<import("node:stream").Readable|null>}
   */
  async logs(instanceId, opts) {
    throw new Error("Not implemented: logs");
  }

  /**
   * List all managed instances.
   * @returns {Promise<string[]>} instance IDs
   */
  async list() {
    throw new Error("Not implemented: list");
  }

  /**
   * Health check for an instance (check if gateway port responds).
   * @param {string} instanceId
   * @returns {Promise<boolean>}
   */
  async health(instanceId) {
    throw new Error("Not implemented: health");
  }

  /**
   * Engine type identifier.
   * @returns {string} "docker" | "process"
   */
  get type() {
    throw new Error("Not implemented: type");
  }
}
