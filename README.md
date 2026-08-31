# CDSL Encrypt Service — Windows Deployment Guide

A lightweight Node.js microservice that encrypts CDSL BO CSV files using the native `Encrypt.exe` binary. **Must be deployed on a Windows machine.**

---

## Prerequisites

- **Windows Server** (or any Windows PC with a static/public IP)
- **Node.js 18+** — Download from [nodejs.org](https://nodejs.org)
- **Encrypt.exe** — Already included in this folder

---

## Quick Start

```powershell
# 1. Copy this entire folder to your Windows machine
#    e.g. C:\Services\CDSL-ENCRYPT-SERVICE\

# 2. Open PowerShell / Command Prompt
cd C:\Services\CDSL-ENCRYPT-SERVICE

# 3. Install dependencies
npm install

# 4. Start the service
npm start

# Output:
# ═══════════════════════════════════════════════
#   CDSL Encrypt Service running on port 4500
#   Platform: win32 (x64)
#   Encrypt.exe: ✅ Found
# ═══════════════════════════════════════════════
```

---

## Test It

```powershell
# Health check
curl http://localhost:4500/health

# Encrypt a test CSV
curl -X POST http://localhost:4500/encrypt ^
  -H "Content-Type: text/plain" ^
  -d "CntrlSctiesDpstryPtcpt,BrnchId,BtchId..." ^
  --output encrypted.bin
```

---

## Connect to Your Main Backend (Coolify / Linux)

Add this environment variable to your BE deployment:

```
CDSL_ENCRYPT_SERVICE_URL=http://<windows-server-ip>:4500
```

The BE will call `POST /encrypt` on this URL whenever it needs to encrypt a CDSL CSV file.

---

## Keep It Running 24/7

### Option A: PM2 (Recommended — Easiest)

```powershell
# Install PM2 globally
npm install -g pm2

# Start the service with PM2
pm2 start server.js --name cdsl-encrypt

# Save the process list (auto-restart on reboot)
pm2 save

# Generate startup script
pm2 startup
```

### Option B: NSSM (Windows Service)

```powershell
# 1. Download nssm from https://nssm.cc/download
# 2. Extract and run:
nssm install CdslEncryptService "C:\Program Files\nodejs\node.exe" "C:\Services\CDSL-ENCRYPT-SERVICE\server.js"

# 3. Start the service
nssm start CdslEncryptService

# 4. Check status
nssm status CdslEncryptService
```

---

## Firewall Configuration

Open port 4500 on the Windows Firewall:

```powershell
netsh advfirewall firewall add rule name="CDSL Encrypt Service" dir=in action=allow protocol=TCP localport=4500
```

> **Security Tip**: For production, restrict to only your Coolify server's IP:
> ```powershell
> netsh advfirewall firewall add rule name="CDSL Encrypt Service" dir=in action=allow protocol=TCP localport=4500 remoteip=<YOUR_COOLIFY_IP>
> ```

---

## Optional: API Key Protection

Set the `API_KEY` environment variable before starting:

```powershell
set API_KEY=your-secret-key-here
npm start
```

Then in your BE `.env`:
```
CDSL_ENCRYPT_SERVICE_URL=http://<windows-ip>:4500
CDSL_ENCRYPT_SERVICE_API_KEY=your-secret-key-here
```

---

## Endpoints

| Method | Path              | Description                                         |
| ------ | ----------------- | --------------------------------------------------- |
| GET    | `/health`         | Health check (no auth required)                     |
| POST   | `/encrypt`        | Encrypt CSV → returns `.CSV.ENC.00` binary buffer   |
| POST   | `/encrypt-and-zip`| Encrypt CSV → returns `.csv.enc.00.zip` archive     |

### POST /encrypt

**Request**:
- `Content-Type: text/plain` with raw CSV body, OR
- `Content-Type: application/json` with `{ "csv": "...", "fileName": "BO_UPLD_059100_..." }`

**Response**: Binary buffer of the encrypted file (`application/octet-stream`)

### POST /encrypt-and-zip

Same input as `/encrypt`, returns a ZIP file containing the encrypted `.CSV.ENC.00` file.

---

## Architecture

```
┌──────────────────────┐         ┌──────────────────────────┐
│  Coolify (Linux)     │  HTTP   │  Windows Server          │
│  BE Server           │ ──────> │  CDSL-ENCRYPT-SERVICE    │
│                      │  POST   │  Port 4500               │
│  pushCDSL.js         │ /encrypt│                          │
│                      │ <────── │  Encrypt.exe (native)    │
│  → ZIP + Upload      │ buffer  │                          │
│    to CDSL Gateway   │         │                          │
└──────────────────────┘         └──────────────────────────┘
```
