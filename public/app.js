'use strict';

// ─── Tab-Navigation ──────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ─── Einstellungen laden & speichern ─────────────────────────────────────────

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error('Konfiguration konnte nicht geladen werden.');
    const cfg = await res.json();
    setFieldValue('SOURCE_DIR',     cfg.SOURCE_DIR);
    setFieldValue('SQL_BACKUP_DIR', cfg.SQL_BACKUP_DIR);
    setFieldValue('MYSQL_BIN',      cfg.MYSQL_BIN);
    setFieldValue('DB_HOST',        cfg.DB_HOST);
    setFieldValue('DB_PORT',        cfg.DB_PORT);
    setFieldValue('DB_USER',        cfg.DB_USER);
    setFieldValue('DB_PASS',        cfg.DB_PASS);
  } catch (err) {
    console.error('Config laden:', err.message);
  }
}

function setFieldValue(id, value) {
  const el = document.getElementById(id);
  if (el && value !== undefined && value !== null) el.value = value;
}

document.getElementById('settings-form').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('settings-msg');
  msg.textContent = '';
  msg.className   = 'inline-msg';

  const body = {
    SOURCE_DIR:     field('SOURCE_DIR'),
    SQL_BACKUP_DIR: field('SQL_BACKUP_DIR'),
    MYSQL_BIN:      field('MYSQL_BIN'),
    DB_HOST:        field('DB_HOST'),
    DB_PORT:        field('DB_PORT'),
    DB_USER:        field('DB_USER'),
    DB_PASS:        field('DB_PASS')
  };

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('Speichern fehlgeschlagen.');
    msg.textContent = '✓ Gespeichert';
    msg.classList.add('ok');
    setTimeout(() => { msg.textContent = ''; msg.className = 'inline-msg'; }, 3000);
  } catch (err) {
    msg.textContent = '✗ ' + err.message;
    msg.classList.add('fail');
  }
});

// ─── Projekt erstellen ────────────────────────────────────────────────────────

const createForm  = document.getElementById('create-form');
const createBtn   = document.getElementById('create-btn');
const logWrap     = document.getElementById('log-wrap');
const logOutput   = document.getElementById('log-output');
const logStatus   = document.getElementById('log-status');
const btnClearLog = document.getElementById('btn-clear-log');

let activeSource = null; // SSE EventSource

btnClearLog.addEventListener('click', () => {
  logOutput.innerHTML = '';
  logStatus.textContent = '';
  logStatus.className   = 'log-status';
  logWrap.classList.add('hidden');
});

createForm.addEventListener('submit', async e => {
  e.preventDefault();

  if (activeSource) {
    activeSource.close();
    activeSource = null;
  }

  const targetDir   = field('targetDir');
  const dbName      = field('dbName');
  const managerUser = field('managerUser');
  const managerPass = field('managerPass');

  if (!targetDir || !dbName || !managerUser || !managerPass) {
    appendLog('Alle Felder müssen ausgefüllt sein.', 'error');
    showLog();
    return;
  }

  // UI: bereit machen
  setFormDisabled(true);
  logOutput.innerHTML  = '';
  logStatus.textContent = 'Läuft …';
  logStatus.className   = 'log-status running';
  showLog();

  try {
    // Job starten
    const startRes = await fetch('/api/create-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetDir, dbName, managerUser, managerPass })
    });

    if (!startRes.ok) {
      const err = await startRes.json().catch(() => ({ error: 'Unbekannter Fehler' }));
      throw new Error(err.error || 'Projekt-Start fehlgeschlagen.');
    }

    const { jobId } = await startRes.json();

    // SSE-Stream öffnen
    let jobFinished = false;
    activeSource = new EventSource(`/api/stream/${jobId}`);

    activeSource.onmessage = evt => {
      let data;
      try { data = JSON.parse(evt.data); } catch (_) { return; }

      appendLog(data.message, data.type);

      if (data.done) {
        jobFinished = true;
        activeSource.close();
        activeSource = null;
        setFormDisabled(false);

        if (data.type === 'success') {
          logStatus.textContent = '✓ Fertig';
          logStatus.className   = 'log-status ok';
        } else {
          logStatus.textContent = '✗ Fehler';
          logStatus.className   = 'log-status fail';
        }
      }
    };

    activeSource.onerror = () => {
      if (jobFinished) return; // Verbindung wurde absichtlich geschlossen
      activeSource.close();
      activeSource = null;
      setFormDisabled(false);
      appendLog('Verbindung zum Server unterbrochen.', 'error');
      logStatus.textContent = '✗ Verbindungsfehler';
      logStatus.className   = 'log-status fail';
    };

  } catch (err) {
    setFormDisabled(false);
    appendLog(err.message, 'error');
    logStatus.textContent = '✗ Fehler';
    logStatus.className   = 'log-status fail';
  }
});

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function field(id) {
  return (document.getElementById(id)?.value || '').trim();
}

function showLog() {
  logWrap.classList.remove('hidden');
}

function appendLog(message, type = 'info') {
  if (!message) return;

  // Typ bestimmen (Schritt-Zeilen erkennen)
  let lineClass = 'log-line-info';
  if (type === 'success') lineClass = 'log-line-success';
  else if (type === 'error') lineClass = 'log-line-error';
  else if (message.startsWith('──')) lineClass = 'log-line-step';

  // Mehrzeilige Nachrichten aufteilen
  const lines = message.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const span = document.createElement('span');
    span.className   = `log-line ${lineClass}`;
    span.textContent = line;
    logOutput.appendChild(span);
    logOutput.appendChild(document.createTextNode('\n'));
  }

  // Auto-scroll ans Ende
  logOutput.scrollTop = logOutput.scrollHeight;
}

function setFormDisabled(disabled) {
  createForm.querySelectorAll('input, button').forEach(el => {
    el.disabled = disabled;
  });
}

// ─── Init ────────────────────────────────────────────────────────────────────

loadConfig();
