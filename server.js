'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { spawn } = require('child_process');
const bcrypt  = require('bcryptjs');

const app        = express();
const PORT       = 3399;
const CONFIG_FILE = path.join(__dirname, 'config.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  SOURCE_DIR:     '',
  SQL_BACKUP_DIR: '',
  DB_HOST:        '127.0.0.1',
  DB_PORT:        '3306',
  DB_USER:        'root',
  DB_PASS:        '',
  MYSQL_BIN:      'mysql'
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    }
  } catch (_) { /* use defaults */ }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

app.get('/api/config', (_req, res) => res.json(loadConfig()));

app.post('/api/config', (req, res) => {
  const cfg = { ...loadConfig(), ...req.body };
  saveConfig(cfg);
  res.json({ success: true });
});

// ─── Job store ───────────────────────────────────────────────────────────────

const jobs = new Map();

function createJob() {
  const id = crypto.randomBytes(8).toString('hex');
  jobs.set(id, { id, logs: [], done: false, success: false, clients: new Set() });
  // Auto-cleanup after 10 minutes
  setTimeout(() => jobs.delete(id), 10 * 60 * 1000);
  return id;
}

function jobLog(jobId, message, type = 'info') {
  const job = jobs.get(jobId);
  if (!job) return;
  const entry = { type, message };
  job.logs.push(entry);
  for (const client of job.clients) {
    client.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
}

function jobDone(jobId, success, message) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.done    = true;
  job.success = success;
  const entry = { type: success ? 'success' : 'error', message, done: true };
  job.logs.push(entry);
  for (const client of job.clients) {
    client.write(`data: ${JSON.stringify(entry)}\n\n`);
    client.end();
  }
  job.clients.clear();
}

// ─── SSE stream endpoint ──────────────────────────────────────────────────────

app.get('/api/stream/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job nicht gefunden.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Replay already collected logs
  for (const entry of job.logs) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  if (job.done) { res.end(); return; }

  job.clients.add(res);
  req.on('close', () => job.clients.delete(res));
});

// ─── Helper: run a child process and stream output ────────────────────────────

function runProc(jobId, cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { ...options });

    let stderrBuf = '';

    proc.stdout.on('data', d => {
      const text = d.toString().trim();
      if (text) jobLog(jobId, text);
    });

    proc.stderr.on('data', d => {
      const text = d.toString().trim();
      if (text) {
        stderrBuf += text + '\n';
        jobLog(jobId, text);
      }
    });

    proc.on('error', err => reject(new Error(`Prozess-Fehler (${cmd}): ${err.message}`)));

    proc.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`"${cmd}" beendet mit Code ${code}.\n${stderrBuf.trim()}`));
      }
    });
  });
}

// ─── Project creation ─────────────────────────────────────────────────────────

app.post('/api/create-project', (req, res) => {
  const { targetDir, dbName, managerUser, managerPass } = req.body;
  const jobId = createJob();
  res.json({ jobId });
  runProjectCreation(jobId, { targetDir, dbName, managerUser, managerPass });
});

// Liest eine .env-Datei und gibt Key-Value-Objekt zurück
function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const result = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    result[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return result;
}

// Parst mysql://user:pass@host:port/dbname aus einer DATABASE_URL
function parseDbUrl(url) {
  const m = url.match(/^mysql:\/\/([^:@]+)(?::([^@]*))?@([^:]+):(\d+)\/([^?]+)/);
  if (!m) return null;
  return { user: m[1], pass: m[2] ? decodeURIComponent(m[2]) : '', host: m[3], port: m[4], dbname: m[5] };
}

async function runProjectCreation(jobId, { targetDir, dbName, managerUser, managerPass }) {
  const log  = (msg, type) => jobLog(jobId, msg, type);
  const done = (ok, msg)   => jobDone(jobId, ok, msg);

  try {
    // ── Validation ──────────────────────────────────────────────────────────
    if (!targetDir || !dbName || !managerUser || !managerPass) {
      return done(false, 'Alle Felder müssen ausgefüllt sein.');
    }

    const cfg = loadConfig();

    if (!cfg.SOURCE_DIR) return done(false, 'SOURCE_DIR ist nicht konfiguriert.');
    if (!fs.existsSync(cfg.SOURCE_DIR)) return done(false, `SOURCE_DIR existiert nicht: ${cfg.SOURCE_DIR}`);
    if (!cfg.SQL_BACKUP_DIR) return done(false, 'SQL_BACKUP_DIR ist nicht konfiguriert.');
    if (!fs.existsSync(cfg.SQL_BACKUP_DIR)) return done(false, `SQL_BACKUP_DIR existiert nicht: ${cfg.SQL_BACKUP_DIR}`);

    // Neueste SQL-Datei
    const sqlFiles = fs.readdirSync(cfg.SQL_BACKUP_DIR)
      .filter(f => f.toLowerCase().endsWith('.sql'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(cfg.SQL_BACKUP_DIR, f)).mtime.getTime() }))
      .sort((a, b) => b.mtime - a.mtime);
    if (sqlFiles.length === 0) return done(false, `Keine .sql-Dateien in: ${cfg.SQL_BACKUP_DIR}`);
    const latestSql = path.join(cfg.SQL_BACKUP_DIR, sqlFiles[0].name);
    log(`Neueste SQL-Datei: ${sqlFiles[0].name}`);

    // Quell-DB aus SOURCE_DIR/.env.local (bzw. .env) lesen
    const srcEnv = { ...parseEnvFile(path.join(cfg.SOURCE_DIR, '.env')),
                     ...parseEnvFile(path.join(cfg.SOURCE_DIR, '.env.local')) };
    const srcDbUrl = srcEnv.DATABASE_URL;
    if (!srcDbUrl) return done(false, 'Keine DATABASE_URL in der Quell-.env gefunden.');
    const srcDb = parseDbUrl(srcDbUrl);
    if (!srcDb) return done(false, `DATABASE_URL konnte nicht geparst werden: ${srcDbUrl}`);
    log(`Quell-Datenbank: ${srcDb.dbname}`);

    const mysqlBin     = cfg.MYSQL_BIN || 'mysql';
    // mysqldump liegt im gleichen Verzeichnis wie mysql
    const mysqldumpBin = mysqlBin.replace(/mysql$/, 'mysqldump');

    const mysqlBaseArgs = [
      `-h${cfg.DB_HOST}`, `-P${cfg.DB_PORT}`,
      `-u${cfg.DB_USER}`, ...(cfg.DB_PASS ? [`-p${cfg.DB_PASS}`] : [])
    ];

    // ── Schritt 1: Zielordner löschen ───────────────────────────────────────
    log('── Schritt 1/7: Zielordner löschen …');
    if (fs.existsSync(targetDir)) {
      await runProc(jobId, 'rm', ['-rf', targetDir]);
      log(`Gelöscht: ${targetDir}`);
    } else {
      log('Zielordner existiert noch nicht.');
    }

    // ── Schritt 2: rsync ────────────────────────────────────────────────────
    log('── Schritt 2/7: Master-Projekt kopieren (rsync) …');
    const src = cfg.SOURCE_DIR.endsWith('/') ? cfg.SOURCE_DIR : cfg.SOURCE_DIR + '/';
    const dst = targetDir.endsWith('/')      ? targetDir      : targetDir + '/';
    await runProc(jobId, 'rsync', [
      '-a', '--stats',
      '--exclude=var/cache', '--exclude=var/log',
      '--exclude=node_modules', '--exclude=.git',
      '--exclude=clone_master.sh',
      src, dst
    ]);
    log('rsync abgeschlossen.');

    // .env.local des Masters entfernen – wird in Schritt 4 neu geschrieben
    const envLocal = path.join(targetDir, '.env.local');
    if (fs.existsSync(envLocal)) { fs.unlinkSync(envLocal); log('.env.local (Master) entfernt.'); }

    // ── Schritt 3: Datenbank erstellen ──────────────────────────────────────
    log(`── Schritt 3/7: Datenbank erstellen: ${dbName} …`);
    await runProc(jobId, mysqlBin, [
      ...mysqlBaseArgs, '-e',
      `DROP DATABASE IF EXISTS \`${dbName}\`; CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
    ]);
    log(`Datenbank "${dbName}" bereit.`);

    // ── Schritt 4: .env erzeugen ────────────────────────────────────────────
    log('── Schritt 4/7: .env.local erstellen …');
    const appSecret  = crypto.randomBytes(32).toString('hex');
    const dbPassPart = cfg.DB_PASS ? `:${encodeURIComponent(cfg.DB_PASS)}` : '';
    // MySQL-Vollversion für DATABASE_URL ermitteln
    const mysqlVersion = await new Promise(resolve => {
      const p = spawn(mysqlBin, [...mysqlBaseArgs, '-se', 'SELECT VERSION();']);
      let out = '';
      p.stdout.on('data', d => { out += d.toString(); });
      p.on('close', () => resolve(out.trim() || '8.0.0'));
      p.on('error', () => resolve('8.0.0'));
    });
    log(`MySQL Version: ${mysqlVersion}`);
    const dbUrl = `mysql://${cfg.DB_USER}${dbPassPart}@${cfg.DB_HOST}:${cfg.DB_PORT}/${dbName}?serverVersion=${mysqlVersion}&charset=utf8mb4`;
    // Credentials in .env.local – überschreibt die .env aus dem Master
    fs.writeFileSync(path.join(targetDir, '.env.local'), [
      'APP_ENV=dev', `APP_SECRET=${appSecret}`, `DATABASE_URL=${dbUrl}`, ''
    ].join('\n'), 'utf8');
    log('.env.local erstellt.');

    // ── Schritt 5: Schema aus Quell-DB übernehmen (mysqldump --no-data) ─────
    log(`── Schritt 5/7: Schema aus "${srcDb.dbname}" übernehmen …`);
    const srcArgs = [
      `-h${srcDb.host}`, `-P${srcDb.port}`,
      `-u${srcDb.user}`, ...(srcDb.pass ? [`-p${srcDb.pass}`] : []),
      '--no-data', '--skip-lock-tables', '--skip-comments',
      srcDb.dbname
    ];
    await new Promise((resolve, reject) => {
      const dump = spawn(mysqldumpBin, srcArgs);
      const imp  = spawn(mysqlBin, [...mysqlBaseArgs, dbName]);
      dump.stdout.pipe(imp.stdin);
      dump.stderr.on('data', d => { const t = d.toString().trim(); if (t && !t.includes('Warning')) log(t); });
      imp.stderr.on('data',  d => { const t = d.toString().trim(); if (t && !t.includes('Warning')) log(t); });
      dump.on('error', err => reject(new Error(`mysqldump Fehler: ${err.message}`)));
      imp.on('error',  err => reject(new Error(`mysql Fehler: ${err.message}`)));
      let dumpFailed = false;
      dump.on('close', code => { if (code !== 0) dumpFailed = true; });
      imp.on('close', code => {
        if (dumpFailed) return reject(new Error('mysqldump fehlgeschlagen.'));
        if (code !== 0) return reject(new Error('Schema-Import fehlgeschlagen.'));
        resolve();
      });
    });
    log('Schema übernommen.');

    // ── Schritt 6: Daten importieren ────────────────────────────────────────
    log(`── Schritt 6/7: Daten importieren: ${sqlFiles[0].name} …`);
    await new Promise((resolve, reject) => {
      const proc = spawn(mysqlBin, [...mysqlBaseArgs, dbName]);
      let stderrBuf = '';
      proc.stdout.on('data', d => { const t = d.toString().trim(); if (t) log(t); });
      proc.stderr.on('data', d => { const t = d.toString().trim(); if (t) { stderrBuf += t + '\n'; log(t); } });
      proc.on('error', err => reject(new Error(`mysql Fehler: ${err.message}`)));
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`Daten-Import fehlgeschlagen (Code ${code}).\n${stderrBuf.trim()}`));
      });
      const sqlStream = fs.createReadStream(latestSql);
      sqlStream.on('error', err => reject(new Error(`SQL-Datei lesen: ${err.message}`)));
      sqlStream.pipe(proc.stdin);
    });
    log('Daten importiert.');

    // ── Schritt 7: Contao Manager Benutzer + Cache ───────────────────────────
    log('── Schritt 7/7: Contao Manager Benutzer setzen …');
    const managerDir = path.join(targetDir, 'contao-manager');
    if (!fs.existsSync(managerDir)) fs.mkdirSync(managerDir, { recursive: true });
    const rawHash = await bcrypt.hash(managerPass, 10);
    const phpHash = rawHash.replace(/^\$2b\$/, '$2y$');
    fs.writeFileSync(path.join(managerDir, 'users.json'), JSON.stringify({
      users: { [managerUser]: { username: managerUser, password: phpHash, roles: ['ROLE_ADMIN'] } },
      version: 2
    }, null, 2), 'utf8');
    log(`Manager-Benutzer "${managerUser}" gesetzt.`);

    log('Contao Cache leeren …');
    await runProc(jobId, 'php', ['vendor/bin/contao-console', 'cache:clear'], { cwd: targetDir });
    log('Cache geleert.');

    done(true, `Projekt erfolgreich erstellt in: ${targetDir}`);

  } catch (err) {
    done(false, err.message);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nContao Projekt-Generator läuft auf http://localhost:${PORT}\n`);
});
