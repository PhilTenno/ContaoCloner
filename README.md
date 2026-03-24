# ContaoCloner

A lightweight local web tool to quickly generate new Contao projects based on a predefined master installation.

## Overview

**ContaoCloner** automates the setup of new Contao installations by cloning a prepared master project, importing a database backup, and configuring the environment — all through a simple web interface.

Designed for local development workflows using MAMP / MAMP Pro.

---

## Features

- Clone a Contao master template into a new project directory
- Import the latest database backup automatically
- Generate a fresh `.env` configuration
- Create a new Contao Manager user
- Clear Contao cache automatically
- Simple UI with live process logs
- Configurable default settings

---

## Requirements

- macOS
- Node.js (LTS recommended)
- MAMP / MAMP Pro
- MySQL running locally
- PHP available in CLI (`php` command)
- `rsync` available (default on macOS)

---

## Installation

```bash
git clone https://github.com/PhilTenno/ContaoCloner.git
cd contao-cloner
npm install
```

---

## Usage

1. Start the application:

```bash
node server.js
```

2. Open in browser:

```text
http://localhost:3399
```

3. Before creating a project:
   - Create a new host in MAMP Pro (e.g. `https://client-a.local`)
   - Create a new empty database (e.g. `contao_client_a`)

4. Fill in the form:
   - Target directory
   - Database name
   - Contao Manager username
   - Contao Manager password

5. Click **"Create Project"**

---

## Configuration

Settings can be adjusted in the UI or directly in:

```text
config.json
```

### Available Settings

- `SOURCE_DIR` – path to your master Contao project
- `SQL_BACKUP_DIR` – path to database backups (e.g. `templates/backUp`)
- `DB_HOST` – usually `localhost`
- `DB_PORT` – usually `3306` or `8889` (MAMP)
- `DB_USER`
- `DB_PASS`

---

## How It Works

ContaoCloner performs the following steps:

1. Deletes the target directory (if it exists)
2. Copies the master project using `rsync`
3. Imports the latest `.sql` backup into the specified database
4. Generates a new `.env` file
5. Creates a Contao Manager user (`contao-manager/users.json`)
6. Clears the Contao cache

---

## Notes

- The database must already exist before running the generator
- The newest SQL file in the backup directory is used automatically
- MAMP host setup is done manually (no automation included)
- This tool is intended for local development only

---

## Project Structure

```text
/server        → backend logic
/public        → frontend (HTML, CSS, JS)
config.json    → application settings
server.js      → main entry point
```

---

## Disclaimer

This tool executes shell commands (`rsync`, `mysql`, `php`) on your system.  
Use it only in a trusted local environment.

---
