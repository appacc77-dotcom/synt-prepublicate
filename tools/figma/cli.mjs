/**
 * Вызов figma-agent с гарантией полного ответа.
 *
 * Почему не execFileSync: CLI пишет ответ в stdout и завершается, не дожидаясь
 * слива в pipe. На ответах больше 64 КБ (например, base64 картинки) хвост
 * теряется — JSON приходит обрезанным. Поэтому stdout направляется в файл
 * через файловый дескриптор: запись в обычный файл синхронна и ничего не теряет.
 */
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export class FigmaError extends Error {
  constructor(code, message, stderr) {
    super(message);
    this.code = code;
    this.stderr = stderr;
  }
}

function parseJson(text) {
  const at = text.indexOf('{');
  if (at < 0) return null;
  return JSON.parse(text.slice(at));
}

/**
 * Плагин моста периодически теряет связь на секунды — особенно на тяжёлых
 * операциях (экспорт PNG, обход большой секции). Это не ошибка вызова: тот же
 * запрос через мгновение проходит. Без повтора один обрыв валит весь инструмент,
 * и приходится запускать вручную заново.
 */
const TRANSIENT_CODES = new Set(['E_TIMEOUT', 'E_NO_ANSWER', 'E_NO_PLUGIN', 'E_NO_BROKER']);
const TRANSIENT_MESSAGE = /unable to establish connection to figma|failed to export node|not connected|disconnected|no plugin/i;

/** Мост блокирует файл зависшей задачей и сам её не снимает: достаём id. */
const WEDGED = /wedged job (j_[0-9a-z_]+)/i;

export function isTransient(error) {
  if (TRANSIENT_CODES.has(error.code)) return true;
  // Плагин отдаёт свои обрывы как E_EVAL с текстом от Figma — код не помогает,
  // различаем по сообщению.
  // Блокировка зависшей задачей — тоже транспорт: снимаем и повторяем.
  return WEDGED.test(String(error.message ?? '')) || TRANSIENT_MESSAGE.test(String(error.message ?? ''));
}

/**
 * @param {string[]} args аргументы для figma-agent
 * @param {{timeoutMs?: number, retries?: number, onRetry?: (attempt: number, error: FigmaError) => void}} opts
 * @returns {object} разобранный JSON-ответ
 * @throws {FigmaError} если CLI вернул ошибку или не ответил
 */
/**
 * Снимает задачи, чей исход неизвестен: такая задача блокирует очередь моста,
 * и без снятия каждый следующий вызов падает по таймауту или с «Unable to
 * establish connection to Figma». Проверено на живом файле: одна зависшая
 * выгрузка SVG остановила весь конвейер.
 */
function releaseUnknownJobs() {
  try {
    const reply = spawnSync('figma-agent', ['job', '--list'], { encoding: 'utf8', timeout: 15000 });
    const raw = reply.stdout ?? '';
    const at = raw.indexOf('{');
    if (at < 0) return;
    const data = JSON.parse(raw.slice(at));
    for (const job of data.jobs ?? []) {
      if (job.state === 'outcome-unknown') {
        spawnSync('figma-agent', ['job', job.jobId, '--force-release'], { stdio: 'ignore', timeout: 15000 });
      }
    }
  } catch {
    /* очередь недоступна — не наша ошибка */
  }
}

export function runFigma(args, { timeoutMs = 120000, retries = 3, onRetry } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return runFigmaOnce(args, timeoutMs);
    } catch (error) {
      lastError = error;
      // Зависшая задача держит файл и не даёт пройти ничему: снимаем её и
      // повторяем — иначе один застрявший вызов блокирует все следующие.
      const wedged = WEDGED.exec(String(error.message ?? ''));
      if (wedged) {
        spawnSync('figma-agent', ['job', wedged[1], '--force-release'], { stdio: 'ignore', timeout: 15000 });
      } else {
        // Задача с исходом «неизвестен» держит очередь моста: пока её не снять,
        // все следующие вызовы падают с «Unable to establish connection».
        releaseUnknownJobs();
      }

      if (!isTransient(error) || attempt === retries) throw error;
      onRetry?.(attempt, error);
      // Пауза растёт: плагину нужно время вернуться, а не долбить его сразу.
      // Пауза без внешней команды: spawnSync('sleep') не работает вне Unix,
      // а ждать надо на всех платформах.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(attempt * 800));
    }
  }
  throw lastError;
}

function runFigmaOnce(args, timeoutMs) {
  const dir = mkdtempSync(join(tmpdir(), 'figma-cli-'));
  const outPath = join(dir, 'stdout.json');
  const errPath = join(dir, 'stderr.txt');
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');

  let result;
  try {
    result = spawnSync('figma-agent', args, {
      stdio: ['ignore', outFd, errFd],
      timeout: timeoutMs,
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }

  const stdout = readFileSync(outPath, 'utf8');
  const stderr = readFileSync(errPath, 'utf8');
  rmSync(dir, { recursive: true, force: true });

  if (result.error?.code === 'ETIMEDOUT') {
    throw new FigmaError('E_TIMEOUT', `figma-agent ${args[0]}: превышен таймаут ${timeoutMs} мс`, stderr);
  }

  let json = null;
  try {
    json = parseJson(stdout);
  } catch {
    json = null;
  }

  if (!json) {
    throw new FigmaError(
      'E_NO_ANSWER',
      `figma-agent ${args[0]}: не JSON (${stdout.length} байт). ${stderr.slice(0, 200)}`,
      stderr,
    );
  }

  if (json.error) {
    throw new FigmaError(json.error.code ?? 'E_UNKNOWN', json.error.message ?? String(json.error), stderr);
  }

  return json;
}

/** Ждёт живой плагин перед пакетом вызовов: 46 секций подряд не должны падать на первой. */
export function waitForPlugin(timeoutSec = 30) {
  const result = spawnSync('figma-agent', ['status', '--wait', '--timeout', String(timeoutSec)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: (timeoutSec + 5) * 1000,
  });
  return result.status === 0;
}
