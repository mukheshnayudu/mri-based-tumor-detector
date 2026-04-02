# AI MEDVISION — Backend Setup Guide

## Prerequisites

| Tool | Download | Notes |
|------|----------|-------|
| **Node.js** (LTS) | https://nodejs.org/ | Required to run the server |
| **Ollama** | https://ollama.com/ | Already installed ✅ |
| **llava model** | `ollama pull llava` | Vision-capable model |

---

## One-Time Setup

### 1. Install Node.js
Go to https://nodejs.org/ and download the **LTS** version.  
Run the installer — make sure "Add to PATH" is checked.  
Then **restart your terminal / VS Code**.

### 2. Pull the llava model in Ollama
Open a terminal and run:
```
ollama pull llava
```
This downloads the LLaVA multimodal model (~4 GB). Only needed once.

### 3. Install Node dependencies
In the `mriproject` folder, open a terminal and run:
```
npm install
```

---

## Running the App

### Option A — Double-click
Double-click **`start-server.bat`** in the project folder.  
It auto-checks all requirements and launches the server.

### Option B — Terminal
```bash
# Make sure Ollama is running first, then:
node server.js
```

Open your browser at → **http://localhost:3000**

---

## How It Works

```
Browser (index.html / script.js)
        │
        │  POST /api/analyze  (multipart: patient fields + MRI images)
        │  GET  /api/health
        ▼
  server.js  (Express on port 3000)
        │
        │  POST http://localhost:11434/api/generate
        │  (base64 images + clinical prompt → llava model)
        ▼
   Ollama (llava)
        │
        └─ Returns structured JSON report
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Checks Ollama is reachable; returns model list |
| `POST` | `/api/analyze` | Accepts `multipart/form-data` with patient fields + `scans` image files |

---

## Environment Variables (optional)

Set these before running `node server.js` to override defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port for the server |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API base URL |
| `OLLAMA_MODEL` | `llava` | Model name to use |

Example (PowerShell):
```powershell
$env:OLLAMA_MODEL="llava:13b"; node server.js
```

---

## Project Structure

```
mriproject/
├── index.html          ← Frontend (untouched)
├── style.css           ← Styles (untouched)
├── script.js           ← Frontend logic (untouched)
├── server.js           ← ★ Node.js/Express backend (NEW)
├── package.json        ← ★ npm manifest (NEW)
├── start-server.bat    ← ★ One-click launcher (NEW)
└── README.md           ← This file
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `npm` not found | Restart terminal after installing Node.js |
| Backend shows "unavailable" | Make sure `ollama serve` is running |
| Analysis times out | LLaVA is loading — wait 30s and retry |
| "Model not found" error | Run `ollama pull llava` |
