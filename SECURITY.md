# Security Policy

## Supported Versions

Security updates and patches are applied to the latest release:

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

## Security Architecture & Scope

Dry Run Studio runs locally (`localhost`) with strict isolation boundaries:

* **Read-Only Source Execution:** Your original source folder is never modified during builds; all package installs and temporary builds run inside an isolated sandbox directory.
* **Local Credential Encryption:** Per-project GitHub remotes and Cloudflare Pages credentials are encrypted locally on disk using Windows Data Protection API (`DPAPI` / `ProtectedData`), bound to your Windows user login.
* **Localhost Server:** The internal HTTP/SSE server (`src/server.mjs`) is designed strictly for local loopback (`127.0.0.1` / `localhost`) usage and should not be exposed to public networks.

## Reporting a Vulnerability

If you discover a security vulnerability, please **do not open a public GitHub issue**.

Instead, report it privately through GitHub:

1. Go to the **Security** tab at the top of this repository.
2. Click **Report a vulnerability** in the left sidebar (or top-right corner) to open a private security advisory.

### What to include in your report:
* A clear description of the issue and the affected file (`server.mjs`, `sandbox-engine.mjs`, `cloud-deployer.mjs`, or the `.bat` launchers).
* Step-by-step instructions to reproduce it.
* Your Windows and Node.js versions.

Reports are reviewed privately, and a fix will be prepared before any public disclosure.