/**
 * MCP-клиент к `figcraft-cli mcp`: JSON-RPC по stdio, один запрос — одна строка.
 *
 * Зачем свой клиент: зависимостей у проекта нет и не заводим. Нужны ровно
 * четыре операции — initialize, tools/call, закрытие и таймауты.
 *
 * Осторожно с таймерами: в первом прототипе `clearTimeout` не вызывался на
 * успешном ответе, и процесс висел до срабатывания самого длинного таймаута.
 * Здесь таймер снимается всегда.
 */
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT = 300000;

export class McpClient {
  constructor({ command, args = [], timeoutMs = DEFAULT_TIMEOUT }) {
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.buffer = '';
    this.pending = new Map();
    this.stderr = '';
    this.exited = null;
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('exit', (code, signal) => {
      this.exited = { code, signal };
      for (const [, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`figcraft-cli вышел (code=${code} signal=${signal}): ${this.stderr.slice(-400)}`));
      }
      this.pending.clear();
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-8000);
    });
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let at;
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at).trim();
        this.buffer = this.buffer.slice(at + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        this.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) {
          const { code, message: text } = message.error;
          waiter.reject(new Error(`MCP ${code ?? ''} ${text ?? ''}`.trim()));
        } else {
          waiter.resolve(message.result);
        }
      }
    });
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.exited) {
        reject(new Error(`figcraft-cli уже завершился: ${JSON.stringify(this.exited)}`));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`таймаут ${method} (${timeoutMs} мс); stderr: ${this.stderr.slice(-400)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
      this.child.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'design-bridge', version: '1' },
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return result;
  }

  /**
   * tools/call. Сервер отвечает массивом content: текст — это JSON полезной
   * нагрузки (иногда с префиксом), картинки не нужны и пропускаются.
   */
  async call(name, toolArgs = {}, timeoutMs = this.timeoutMs) {
    const result = await this.request('tools/call', { name, arguments: toolArgs }, timeoutMs);
    const content = Array.isArray(result?.content) ? result.content : [];
    if (result?.isError) {
      const text = content.map((item) => item.text ?? '').join(' ').slice(0, 600);
      throw new Error(`${name}: ${text}`);
    }
    const texts = content.filter((item) => item.type === 'text').map((item) => item.text);
    for (const text of texts) {
      const at = text.indexOf('{');
      if (at < 0) continue;
      try {
        return JSON.parse(text.slice(at));
      } catch {
        /* не JSON — берём как текст */
      }
    }
    return texts.length ? texts.join('\n') : result;
  }

  close() {
    try {
      this.child.stdin.end();
    } catch {
      /* уже закрыт */
    }
    if (!this.exited) this.child.kill();
  }
}
