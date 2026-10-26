// Loaded via --import before any test file, so src/config.js never points the
// unit tests at the live data/scraper.db.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-test-'));
process.on('exit', () => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));
