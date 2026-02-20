<div align="center" width="100%">
    <img src="./frontend/public/icon.svg" width="128" alt="Dockge AC" />
</div>

# Dockge AC

Dockge AC is an Apple Container focused stack manager with a reactive web UI.

## Upstream Attribution

Dockge AC is based on the original **Dockge** project by Louis Lam.

- Upstream repository: https://github.com/louislam/dockge
- Original author: https://github.com/louislam

This fork keeps the stack-oriented UX from Dockge and adds Apple `container` runtime support and local operational workflows.

## Features

- Manage `compose.yaml` based stacks
  - Create / Edit / Start / Stop / Restart / Delete
- Interactive editor for `compose.yaml`
- Interactive web terminal
- Multi-agent support
- Runtime visibility for existing system containers
- Image management page with in-use safety checks and delete actions

## Quick Start (Local)

Requirements:

- Node.js >= 22.14
- Apple `container` CLI

Install and run:

```bash
npm install
npm run build:frontend
./launchd-manage.sh start
```

Open:

- http://127.0.0.1:5001

Stop service:

```bash
./launchd-manage.sh stop
```

## Stack Notes

- For local-only images such as `prismcat:local`, Dockge AC now treats them as local references and does not require remote pull.
- For external (non-Dockge-managed) containers, Dockge AC supports start / stop / restart / delete operations in the UI.

## Development

```bash
npm install
npm run dev:backend
npm run dev:frontend
```

Typecheck:

```bash
npx tsc --noEmit
```

## Contribution

- Please use your fork repository issue tracker and discussions after you fork.
- Keep the upstream attribution section when redistributing this fork.
