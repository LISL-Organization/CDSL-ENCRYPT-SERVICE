require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const archiver = require("archiver");
const axios = require("axios");
const FormData = require("form-data");

// Diagnostic log capture
const recentLogs = [];
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

const captureLog = (type, args) => {
  const msg = `[${new Date().toISOString()}] [${type}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`;
  recentLogs.push(msg);
  if (recentLogs.length > 500) {
    recentLogs.shift();
  }
};

console.log = (...args) => {
  captureLog('INFO', args);
  originalLog(...args);
};

console.error = (...args) => {
  captureLog('ERROR', args);
  originalError(...args);
};

console.warn = (...args) => {
  captureLog('WARN', args);
  originalWarn(...args);
};

const app = express();
const PORT = process.env.PORT || 4500;
const API_KEY = process.env.API_KEY || ""; // Optional: set for production security

// The CDSL executables sit in the same directory as this server
const ENCRYPT_EXE_SOURCE = path.join(__dirname, "Encrypt.exe");
const D2U_EXE_SOURCE = path.join(__dirname, "D2U.exe");
const ENC_EXE_SOURCE = path.join(__dirname, "ENC.EXE");

// ─── Middleware ──────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.text({ limit: "50mb", type: "text/*" }));
app.use(express.raw({ limit: "50mb", type: "application/octet-stream" }));

// Optional API key check
app.use((req, res, next) => {
  if (API_KEY && req.path !== "/health") {
    const provided = req.headers["x-api-key"] || req.query.apiKey;
    if (provided !== API_KEY) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
  }
  next();
});

// ─── Health Check ───────────────────────────────────────────────────
app.get("/health", (req, res) => {
  const encryptExists = fs.existsSync(ENCRYPT_EXE_SOURCE);
  const d2uExists = fs.existsSync(D2U_EXE_SOURCE);
  const encExists = fs.existsSync(ENC_EXE_SOURCE);
  res.json({
    status: "ok",
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    executablesFound: {
      "Encrypt.exe": encryptExists,
      "D2U.exe": d2uExists,
      "ENC.EXE": encExists
    },
    uptime: process.uptime(),
  });
});

// ─── Diagnostic Logs ────────────────────────────────────────────────
app.get("/logs", (req, res) => {
  res.json({ logs: recentLogs });
});

// ─── POST /encrypt ──────────────────────────────────────────────────
// Accepts raw CSV content (text/plain or JSON body with { csv, fileName })
// Runs Encrypt.exe natively in standard cdslFilesFolder matching paths (d2u + CDSL)
// Returns the encrypted .CSV.ENC.00 buffer
app.post("/encrypt", async (req, res) => {
  let csvContent = "";
  let fileName = "";

  // Parse input (supports both JSON body and raw text)
  if (typeof req.body === "string") {
    csvContent = req.body;
    fileName = req.query.fileName || `temp_${Date.now()}`;
  } else if (Buffer.isBuffer(req.body)) {
    csvContent = req.body.toString("utf8");
    fileName = req.query.fileName || `temp_${Date.now()}`;
  } else if (req.body && req.body.csv) {
    csvContent = req.body.csv;
    fileName = req.body.fileName || `temp_${Date.now()}`;
  } else {
    return res.status(400).json({ success: false, message: "No CSV content provided. Send as text body, raw body, or JSON { csv, fileName }." });
  }

  if (!csvContent || csvContent.trim().length === 0) {
    return res.status(400).json({ success: false, message: "Empty CSV content" });
  }

  if (!fs.existsSync(ENCRYPT_EXE_SOURCE) || !fs.existsSync(D2U_EXE_SOURCE) || !fs.existsSync(ENC_EXE_SOURCE)) {
    return res.status(500).json({ 
      success: false, 
      message: "Required CDSL binaries missing. Make sure Encrypt.exe, D2U.exe, and ENC.EXE exist in the service folder.",
      found: {
        "Encrypt.exe": fs.existsSync(ENCRYPT_EXE_SOURCE),
        "D2U.exe": fs.existsSync(D2U_EXE_SOURCE),
        "ENC.EXE": fs.existsSync(ENC_EXE_SOURCE)
      }
    });
  }

  // Create isolated directories mimic'ing production layout
  // baseTmpDir/d2u/Encrypt.exe, D2U.exe, ENC.EXE
  // baseTmpDir/CDSL/BO_UPLD_...csv
  const baseTmpDir = path.join(os.tmpdir(), `cdsl_enc_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`);
  const d2uDir = path.join(baseTmpDir, "d2u");
  const cdslDir = path.join(baseTmpDir, "CDSL");
  
  fs.mkdirSync(d2uDir, { recursive: true });
  fs.mkdirSync(cdslDir, { recursive: true });

  const csvBaseName = fileName.replace(/\.(csv|CSV)$/i, "");
  const csvFileName = `${csvBaseName}.csv`;
  const csvFilePath = path.join(cdslDir, csvFileName);
  fs.writeFileSync(csvFilePath, csvContent, "utf8");

  // Copy all three binaries to the temp d2u folder since Encrypt.exe spawns them internally
  const localEncryptExe = path.join(d2uDir, "Encrypt.exe");
  fs.copyFileSync(ENCRYPT_EXE_SOURCE, localEncryptExe);
  fs.copyFileSync(D2U_EXE_SOURCE, path.join(d2uDir, "D2U.exe"));
  fs.copyFileSync(ENC_EXE_SOURCE, path.join(d2uDir, "ENC.EXE"));

  console.log(`[ENCRYPT] Received CSV (${csvContent.length} bytes), file: ${csvFileName}`);
  console.log(`[ENCRYPT] Temp dir: ${baseTmpDir}`);
  console.log(`[ENCRYPT] Running: ${localEncryptExe} "${csvFilePath}" 1`);

  try {
    // Execute Encrypt.exe <csvFilePath> 1
    // The exe reads the CSV and outputs <csvBaseName>.CSV.ENC.00 in the same directory
    await new Promise((resolve, reject) => {
      execFile(
        localEncryptExe,
        [csvFilePath, "1"],
        { cwd: cdslDir, timeout: 30000, shell: true },
        (error, stdout, stderr) => {
          if (stdout) console.log(`[ENCRYPT] stdout: ${stdout}`);
          if (stderr) console.log(`[ENCRYPT] stderr: ${stderr}`);
          if (error) {
            console.error(`[ENCRYPT] execFile error:`, error.message);
            return reject(error);
          }
          resolve();
        }
      );
    });

    // Find the encrypted output file (e.g., .csv.enc.41 or similar dynamic extension) in the CDSL directory
    const files = fs.readdirSync(cdslDir);
    const encFile = files.find((f) => /\.enc\.[a-z0-9]{2}$/i.test(f));

    if (!encFile) {
      console.error(`[ENCRYPT] Encrypted file not found! Files in CDSL:`, files);
      return res.status(500).json({
        success: false,
        message: "Encrypt.exe did not produce an encrypted output file",
        filesInCDSL: files,
      });
    }

    const encFilePath = path.join(cdslDir, encFile);
    const encBuffer = fs.readFileSync(encFilePath);

    console.log(`[ENCRYPT] ✅ Encrypted successfully: ${encFile} (${encBuffer.length} bytes)`);

    // Return the encrypted buffer
    res.set({
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encFile}"`,
      "X-Encrypted-FileName": encFile,
      "X-Original-Size": String(csvContent.length),
      "X-Encrypted-Size": String(encBuffer.length),
    });
    res.send(encBuffer);
  } catch (err) {
    console.error(`[ENCRYPT] ❌ Encryption failed:`, err.message);
    res.status(500).json({
      success: false,
      message: "Encrypt.exe execution failed: " + err.message,
    });
  } finally {
    // Cleanup temp directories
    try {
      fs.rmSync(baseTmpDir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[ENCRYPT] Cleanup warning: ${e.message}`);
    }
  }
});

// ─── POST /encrypt-and-zip ──────────────────────────────────────────
// Same as /encrypt but returns a ZIP containing the .CSV.ENC.00 file
// with the correct CDSL naming convention
app.post("/encrypt-and-zip", async (req, res) => {
  let csvContent = "";
  let fileName = "";

  if (typeof req.body === "string") {
    csvContent = req.body;
    fileName = req.query.fileName || `temp_${Date.now()}`;
  } else if (Buffer.isBuffer(req.body)) {
    csvContent = req.body.toString("utf8");
    fileName = req.query.fileName || `temp_${Date.now()}`;
  } else if (req.body && req.body.csv) {
    csvContent = req.body.csv;
    fileName = req.body.fileName || `temp_${Date.now()}`;
  } else {
    return res.status(400).json({ success: false, message: "No CSV content provided" });
  }

  if (!csvContent || csvContent.trim().length === 0) {
    return res.status(400).json({ success: false, message: "Empty CSV content" });
  }

  if (!fs.existsSync(ENCRYPT_EXE_SOURCE) || !fs.existsSync(D2U_EXE_SOURCE) || !fs.existsSync(ENC_EXE_SOURCE)) {
    return res.status(500).json({ success: false, message: "Required CDSL binaries missing (Encrypt.exe, D2U.exe, ENC.EXE)" });
  }

  // Create isolated directories mimic'ing production layout
  const baseTmpDir = path.join(os.tmpdir(), `cdsl_enc_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`);
  const d2uDir = path.join(baseTmpDir, "d2u");
  const cdslDir = path.join(baseTmpDir, "CDSL");
  
  fs.mkdirSync(d2uDir, { recursive: true });
  fs.mkdirSync(cdslDir, { recursive: true });

  const csvBaseName = fileName.replace(/\.(csv|CSV)$/i, "");
  const csvFileName = `${csvBaseName}.csv`;
  const csvFilePath = path.join(cdslDir, csvFileName);
  fs.writeFileSync(csvFilePath, csvContent, "utf8");

  // Copy all three binaries to the temp d2u folder
  const localEncryptExe = path.join(d2uDir, "Encrypt.exe");
  fs.copyFileSync(ENCRYPT_EXE_SOURCE, localEncryptExe);
  fs.copyFileSync(D2U_EXE_SOURCE, path.join(d2uDir, "D2U.exe"));
  fs.copyFileSync(ENC_EXE_SOURCE, path.join(d2uDir, "ENC.EXE"));

  console.log(`[ENCRYPT-ZIP] Received CSV (${csvContent.length} bytes), file: ${csvFileName}`);
  console.log(`[ENCRYPT-ZIP] Temp dir: ${baseTmpDir}`);
  console.log(`[ENCRYPT-ZIP] Running: ${localEncryptExe} "${csvFilePath}" 1`);

  try {
    await new Promise((resolve, reject) => {
      execFile(
        localEncryptExe,
        [csvFilePath, "1"],
        { cwd: cdslDir, timeout: 30000, shell: true },
        (error, stdout, stderr) => {
          if (stdout) console.log(`[ENCRYPT-ZIP] stdout: ${stdout}`);
          if (stderr) console.log(`[ENCRYPT-ZIP] stderr: ${stderr}`);
          if (error) return reject(error);
          resolve();
        }
      );
    });

    const files = fs.readdirSync(cdslDir);
    const encFile = files.find((f) => /\.enc\.[a-z0-9]{2}$/i.test(f));

    if (!encFile) {
      return res.status(500).json({
        success: false,
        message: "Encrypt.exe did not produce an encrypted output file",
        filesInCDSL: files,
      });
    }

    const encFilePath = path.join(cdslDir, encFile);
    const encBuffer = fs.readFileSync(encFilePath);

    // Create ZIP archive
    const zipFileName = `${csvBaseName}.csv.enc.00.zip`;
    const zipBuffers = [];

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("data", (data) => zipBuffers.push(data));

    await new Promise((resolve, reject) => {
      archive.on("end", resolve);
      archive.on("error", reject);

      // The file inside the ZIP must be named: <baseName>.CSV.ENC.00
      const innerFileName = `${csvBaseName}.CSV.ENC.00`;
      archive.append(encBuffer, { name: innerFileName });
      archive.finalize();
    });

    const zipBuffer = Buffer.concat(zipBuffers);
    console.log(`[ENCRYPT-ZIP] ✅ Created ZIP: ${zipFileName} (${zipBuffer.length} bytes)`);

    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipFileName}"`,
      "X-Zip-FileName": zipFileName,
      "X-Inner-FileName": `${csvBaseName}.CSV.ENC.00`,
      "X-Original-Size": String(csvContent.length),
      "X-Encrypted-Size": String(encBuffer.length),
      "X-Zip-Size": String(zipBuffer.length),
    });
    res.send(zipBuffer);
  } catch (err) {
    console.error(`[ENCRYPT-ZIP] ❌ Failed:`, err.message);
    res.status(500).json({
      success: false,
      message: "Encrypt.exe execution failed: " + err.message,
    });
  } finally {
    try {
      fs.rmSync(baseTmpDir, { recursive: true, force: true });
    } catch (e) {}
  }
});

// ─── POST /proxy ────────────────────────────────────────────────────
// Acts as a whitelisted tunnel/proxy to CDSL API.
// Supports both standard JSON payloads and multipart/form-data (base64 file buffers).
app.post("/proxy", async (req, res) => {
  const { url, method = "POST", headers = {}, jsonBody = null, multipart = null } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, message: "URL is required" });
  }

  console.log(`[PROXY] Forwarding ${method} request to: ${url}`);

  try {
    const forwardHeaders = {};
    Object.entries(headers).forEach(([key, val]) => {
      const lowerKey = key.toLowerCase();
      if (lowerKey === "authsign") {
        forwardHeaders["AuthSign"] = val;
      } else if (lowerKey === "authtoken") {
        forwardHeaders["AuthToken"] = val;
      } else if (lowerKey === "filecomputehash") {
        forwardHeaders["FileComputeHash"] = val;
      } else if (lowerKey === "referer") {
        forwardHeaders["Referer"] = val;
      } else {
        forwardHeaders[key] = val;
      }
    });

    // Remove headers that might interfere
    delete forwardHeaders.host;
    delete forwardHeaders.connection;
    delete forwardHeaders["content-length"];

    let response;

    if (multipart) {
      const form = new FormData();
      
      // Append form fields
      if (multipart.fields) {
        Object.entries(multipart.fields).forEach(([key, val]) => {
          form.append(key, val);
        });
      }

      // Reconstruct file buffer from base64
      if (multipart.file) {
        const fileBuffer = Buffer.from(multipart.file.base64, "base64");
        form.append(multipart.file.fieldName || "file", fileBuffer, {
          filename: multipart.file.filename || "upload.zip",
          contentType: multipart.file.contentType || "application/zip",
        });
      }

      // Merge headers
      const formHeaders = form.getHeaders();
      Object.assign(forwardHeaders, formHeaders);

      response = await axios({
        url,
        method,
        headers: forwardHeaders,
        data: form,
        timeout: 30000,
        validateStatus: () => true
      });
    } else {
      // Standard JSON request
      response = await axios({
        url,
        method,
        headers: forwardHeaders,
        data: jsonBody,
        timeout: 30000,
        validateStatus: () => true
      });
    }

    console.log(`[PROXY] Gateway responded with status: ${response.status}`);

    // Forward the headers and response body back
    res.status(response.status);
    Object.entries(response.headers).forEach(([key, val]) => {
      if (key.toLowerCase() !== "transfer-encoding") {
        res.set(key, val);
      }
    });

    res.send(response.data);
  } catch (err) {
    console.error(`[PROXY] ❌ Forwarding failed:`, err.message);
    res.status(500).json({ success: false, message: "Proxy forwarding error: " + err.message });
  }
});

// ─── POST /files ────────────────────────────────────────────────────
// Diagnostic endpoint to list directories and read files on the Windows VPS.
app.post("/files", async (req, res) => {
  const { path: dirPath, readPath } = req.body;
  
  try {
    if (readPath) {
      if (fs.existsSync(readPath)) {
        const content = fs.readFileSync(readPath, "utf8");
        return res.json({ success: true, content });
      }
      return res.status(404).json({ success: false, message: "File not found: " + readPath });
    }

    const targetPath = dirPath || "D:\\";
    if (fs.existsSync(targetPath)) {
      const items = fs.readdirSync(targetPath).map(name => {
        const full = path.join(targetPath, name);
        let isDir = false;
        try {
          isDir = fs.statSync(full).isDirectory();
        } catch (e) {}
        return { name, isDir };
      });
      return res.json({ success: true, items });
    }
    return res.status(404).json({ success: false, message: "Directory not found: " + targetPath });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Start Server ───────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log("═══════════════════════════════════════════════");
  console.log(`  CDSL Encrypt Service running on port ${PORT}`);
  console.log(`  Platform: ${os.platform()} (${os.arch()})`);
  console.log(`  Node.js:  ${process.version}`);
  console.log(`  Encrypt.exe: ${fs.existsSync(ENCRYPT_EXE_SOURCE) ? "✅ Found" : "❌ NOT FOUND"}`);
  console.log(`  D2U.exe:     ${fs.existsSync(D2U_EXE_SOURCE) ? "✅ Found" : "❌ NOT FOUND"}`);
  console.log(`  ENC.EXE:     ${fs.existsSync(ENC_EXE_SOURCE) ? "✅ Found" : "❌ NOT FOUND"}`);
  console.log(`  API Key:  ${API_KEY ? "✅ Enabled" : "⚠️  Disabled (open access)"}`);
  console.log("═══════════════════════════════════════════════");
  console.log(`  Endpoints:`);
  console.log(`    GET  /health          → Health check`);
  console.log(`    POST /encrypt         → Encrypt CSV → returns .CSV.ENC.00 buffer`);
  console.log(`    POST /encrypt-and-zip → Encrypt CSV → returns .csv.enc.00.zip`);
  console.log("═══════════════════════════════════════════════");
});
