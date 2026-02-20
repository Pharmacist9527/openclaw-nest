# openclaw-nest

Multi-instance OpenClaw manager with dual-engine architecture (Docker + Process).

## Quick Start

```bash
# Install dependencies
npm install

# Local mode (opens browser)
node bin/nest.js

# Server mode (headless, 0.0.0.0)
node bin/nest.js --server --port 6800

# Force process engine
node bin/nest.js --server --engine=process
```

## Build

```bash
# Bundle to single CJS file
npm run build

# Package to standalone executable
npm run package
```

## Docker

```bash
# Build and run
docker compose up -d

# Set host data path for sibling container bind mounts
HOST_DATA_PATH=/opt/openclaw-nest docker compose up -d
```

## Architecture

- **ProcessEngine**: Runs OpenClaw instances as child processes (no Docker required)
- **DockerEngine**: Runs instances as sibling Docker containers (Phase 2)
- **Auto-detect**: Checks Docker socket availability, falls back to ProcessEngine

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Web UI |
| POST | `/auth/login` | Login (server mode) |
| GET | `/instances` | List all instances |
| GET | `/instances/:id` | Instance detail |
| POST | `/instances` | Create instance (returns ticket) |
| GET | `/instances/:id/deploy-stream` | SSE deploy progress |
| POST | `/instances/:id/start` | Start instance |
| POST | `/instances/:id/stop` | Stop instance |
| POST | `/instances/:id/restart` | Restart instance |
| DELETE | `/instances/:id` | Delete instance |
| GET | `/instances/:id/logs` | SSE log stream |
| PUT | `/instances/:id/config` | Update config |
| GET | `/engine/info` | Engine type info |
