require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const archiver = require("archiver");

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

// The Encrypt.exe binary sits in the same directory as this server
const ENCRYPT_EXE_SOURCE = path.join(__dirname, "Encrypt.exe");

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
  const exeExists = fs.existsSync(ENCRYPT_EXE_SOURCE);
  res.json({
    status: "ok",
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    encryptExeFound: exeExists,
    encryptExePath: ENCRYPT_EXE_SOURCE,
    uptime: process.uptime(),
  });
});

// ─── Diagnostic Logs ────────────────────────────────────────────────
app.get("/logs", (req, res) => {
  res.json({ logs: recentLogs });
});

// ─── POST /encrypt ──────────────────────────────────────────────────
// Accepts raw CSV content (text/plain or JSON body with { csv, fileName })
// Runs Encrypt.exe natively on Windows using local paths to avoid Borland MAX_PATH issues
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

  if (!fs.existsSync(ENCRYPT_EXE_SOURCE)) {
    return res.status(500).json({ success: false, message: "Encrypt.exe not found at " + ENCRYPT_EXE_SOURCE });
  }

  // Create a unique temp directory for this request
  const tmpDir = path.join(os.tmpdir(), `cdsl_enc_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const csvBaseName = fileName.replace(/\.(csv|CSV)$/i, "");
  
  // Write the CSV file directly inside the temp folder
  const csvFileName = `${csvBaseName}.csv`;
  const csvFilePath = path.join(tmpDir, csvFileName);
  fs.writeFileSync(csvFilePath, csvContent, "utf8");

  // Copy Encrypt.exe to the temp folder to run it locally relative to the CSV file
  // This bypasses Borland C++ MAX_PATH length limits and command line backslash issues.
  const localEncryptExe = path.join(tmpDir, "Encrypt.exe");
  fs.copyFileSync(ENCRYPT_EXE_SOURCE, localEncryptExe);

  console.log(`[ENCRYPT] Received CSV (${csvContent.length} bytes), file: ${csvFileName}`);
  console.log(`[ENCRYPT] Temp dir: ${tmpDir}`);
  console.log(`[ENCRYPT] Running: ${localEncryptExe} ${csvFileName} 1`);

  try {
    // Execute Encrypt.exe <csvFileName> 1
    // The exe reads the CSV and outputs <csvBaseName>.CSV.ENC.00 in the same directory
    await new Promise((resolve, reject) => {
      execFile(
        localEncryptExe,
        [csvFileName, "1"],
        { cwd: tmpDir, timeout: 30000, shell: true },
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

    // Find the encrypted output file (.CSV.ENC.00 or .csv.enc.00)
    const files = fs.readdirSync(tmpDir);
    const encFile = files.find((f) => /\.CSV\.ENC\.00$/i.test(f) || /\.enc\.00$/i.test(f));

    if (!encFile) {
      console.error(`[ENCRYPT] Encrypted file not found! Files in tmpDir:`, files);
      return res.status(500).json({
        success: false,
        message: "Encrypt.exe did not produce an encrypted output file",
        filesInTmp: files,
      });
    }

    const encFilePath = path.join(tmpDir, encFile);
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
    // Cleanup temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
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

  if (!fs.existsSync(ENCRYPT_EXE_SOURCE)) {
    return res.status(500).json({ success: false, message: "Encrypt.exe not found" });
  }

  // Create a unique temp directory for this request
  const tmpDir = path.join(os.tmpdir(), `cdsl_enc_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const csvBaseName = fileName.replace(/\.(csv|CSV)$/i, "");
  
  // Write the CSV file directly inside the temp folder
  const csvFileName = `${csvBaseName}.csv`;
  const csvFilePath = path.join(tmpDir, csvFileName);
  fs.writeFileSync(csvFilePath, csvContent, "utf8");

  // Copy Encrypt.exe to the temp folder to run it locally relative to the CSV file
  const localEncryptExe = path.join(tmpDir, "Encrypt.exe");
  fs.copyFileSync(ENCRYPT_EXE_SOURCE, localEncryptExe);

  console.log(`[ENCRYPT-ZIP] Received CSV (${csvContent.length} bytes), file: ${csvFileName}`);
  console.log(`[ENCRYPT-ZIP] Temp dir: ${tmpDir}`);
  console.log(`[ENCRYPT-ZIP] Running: ${localEncryptExe} ${csvFileName} 1`);

  try {
    await new Promise((resolve, reject) => {
      execFile(
        localEncryptExe,
        [csvFileName, "1"],
        { cwd: tmpDir, timeout: 30000, shell: true },
        (error, stdout, stderr) => {
          if (stdout) console.log(`[ENCRYPT-ZIP] stdout: ${stdout}`);
          if (stderr) console.log(`[ENCRYPT-ZIP] stderr: ${stderr}`);
          if (error) return reject(error);
          resolve();
        }
      );
    });

    const files = fs.readdirSync(tmpDir);
    const encFile = files.find((f) => /\.CSV\.ENC\.00$/i.test(f) || /\.enc\.00$/i.test(f));

    if (!encFile) {
      return res.status(500).json({
        success: false,
        message: "Encrypt.exe did not produce an encrypted output file",
        filesInTmp: files,
      });
    }

    const encFilePath = path.join(tmpDir, encFile);
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
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  }
});

// ─── Start Server ───────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log("═══════════════════════════════════════════════");
  console.log(`  CDSL Encrypt Service running on port ${PORT}`);
  console.log(`  Platform: ${os.platform()} (${os.arch()})`);
  console.log(`  Node.js:  ${process.version}`);
  console.log(`  Encrypt.exe: ${fs.existsSync(ENCRYPT_EXE_SOURCE) ? "✅ Found" : "❌ NOT FOUND"}`);
  console.log(`  API Key:  ${API_KEY ? "✅ Enabled" : "⚠️  Disabled (open access)"}`);
  console.log("═══════════════════════════════════════════════");
  console.log(`  Endpoints:`);
  console.log(`    GET  /health          → Health check`);
  console.log(`    POST /encrypt         → Encrypt CSV → returns .CSV.ENC.00 buffer`);
  console.log(`    POST /encrypt-and-zip → Encrypt CSV → returns .csv.enc.00.zip`);
  console.log("═══════════════════════════════════════════════");
});
