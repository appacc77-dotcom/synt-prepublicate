#!/usr/bin/env node
/**
 * Замок для шагов, которые трогают общий dist/ и общий сервер сборки.
 *
 *   node tools/lock.mjs "npm run build && node tools/measure.mjs <spec> --url /<page>"
 *
 * Зачем: `astro build` пишет в dist/, а measure отдаёт этот же dist по HTTP.
 * Два агента, собирающих одновременно, портят друг другу и сборку, и замер.
 * Замок сериализует связку «собрать → замерить», оставляя остальную работу
 * параллельной.
 *
 * Внутри замка лежит owner.json (pid, host, время). Чужой замок снимается,
 * только если владелец точно мёртв: тот же хост и процесса нет, либо замок
 * старше пяти минут и владелец не проверяем (другой хост, нет owner.json).
 * Раньше замок снимался по одному возрасту — и долгий живой прогон
 * (сборка + замер дольше пяти минут) терял его посреди работы.
 */
import { mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const LOCK = '.build.lock';
const STALE_MS = 5 * 60 * 1000;
const WAIT_MS = 200;
const DEADLINE_MS = 10 * 60 * 1000;

const OWNER = join(LOCK, 'owner.json');
const host = hostname();

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM — процесс есть, но чужой: считаем живым.
    return error.code === 'EPERM';
  }
}

/** Можно ли снять чужой замок. */
function abandoned() {
  let owner = null;
  try {
    owner = JSON.parse(readFileSync(OWNER, 'utf8'));
  } catch {
    // owner.json ещё не записан (гонка) или замок старого формата
  }
  if (owner && owner.host === host && Number.isInteger(owner.pid)) return !alive(owner.pid);
  return Date.now() - statSync(LOCK).mtimeMs > STALE_MS;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const command = process.argv.slice(2).join(' ').replace(/^--\s*/, '');
if (!command) {
  console.error('использование: node tools/lock.mjs "<команда>"');
  process.exit(2);
}

const started = Date.now();
let taken = false;

while (!taken) {
  try {
    mkdirSync(LOCK);
    writeFileSync(OWNER, JSON.stringify({ pid: process.pid, host, at: new Date().toISOString(), command }) + '\n');
    taken = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;

    // Замок от упавшего агента не должен блокировать навсегда.
    try {
      if (abandoned()) {
        console.error('замок брошен (владелец не жив) — снимаю');
        rmSync(LOCK, { recursive: true, force: true });
        continue;
      }
    } catch {
      // замок исчез между попытками — просто пробуем снова
    }

    if (Date.now() - started > DEADLINE_MS) {
      console.error('замок занят больше 10 минут — сдаюсь');
      process.exit(3);
    }
    sleep(WAIT_MS);
  }
}

let status = 1;
try {
  const result = spawnSync('sh', ['-c', command], { stdio: 'inherit' });
  status = result.status ?? 1;
} finally {
  try {
    rmSync(LOCK, { recursive: true, force: true });
  } catch {
    // уже снят
  }
}

process.exit(status);
