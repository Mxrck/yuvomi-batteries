// Publishes the module page shipped in this image into /modules-out (Yuvomi's modules folder,
// mounted from the host). Idempotent: with the same version already in place nothing is written,
// so container restarts never disturb an operator's changes inside that folder. Runs as root
// (called by entrypoint.sh) so it can chown the result to Yuvomi's user (1000:1000).
import { chownSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const SRC = '/app/modules/batteries';
const OUT_DIR = '/modules-out';
const DST = join(OUT_DIR, 'batteries');
const TMP = join(OUT_DIR, '.batteries-incoming');
const UID = 1000;
const GID = 1000;

const log = (msg, extra = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));

const versionOf = (dir) => {
  try { return JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8')).version ?? null; } catch { return null; }
};

function chownTree(dir) {
  chownSync(dir, UID, GID);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (lstatSync(p).isDirectory()) chownTree(p);
    else chownSync(p, UID, GID);
  }
}

mkdirSync(OUT_DIR, { recursive: true });
const have = versionOf(DST);
const want = versionOf(SRC);
if (have === want && existsSync(DST)) {
  log('module page already published', { version: want });
} else {
  rmSync(TMP, { recursive: true, force: true });
  cpSync(SRC, TMP, { recursive: true });
  chownTree(TMP);
  rmSync(DST, { recursive: true, force: true });
  renameSync(TMP, DST);
  log('module page published', { previous: have, version: want });
}
