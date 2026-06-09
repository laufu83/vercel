import { Request } from 'express';
import { v4 } from 'uuid';

export class Logger {
  private reqId: string;
  private path?: string;
  private method?: string;

  constructor(req?: Request) {
    this.reqId = req?.headers['x-request-id'] as string || v4();
    this.path = req?.path;
    this.method = req?.method;
  }

  private getPrefix() {
    return `[${this.reqId}] ${this.method} ${this.path}`;
  }

  info(message: string, ...args: any[]) {
    console.log(`\x1b[32m[INFO]\x1b[0m ${this.getPrefix()} | ${message}`, ...args);
  }

  warn(message: string, ...args: any[]) {
    console.warn(`\x1b[33m[WARN]\x1b[0m ${this.getPrefix()} | ${message}`, ...args);
  }

  error(message: string, error?: any, ...args: any[]) {
    console.error(`\x1b[31m[ERROR]\x1b[0m ${this.getPrefix()} | ${message}`, error?.stack || error || '', ...args);
  }

  redis(action: string, key: string, ...args: any[]) {
    console.log(`\x1b[36m[REDIS]\x1b[0m ${this.getPrefix()} | ${action} | key=${key}`, ...args);
  }

  db(sql: string, ...args: any[]) {
    console.log(`\x1b[34m[DB]\x1b[0m ${this.getPrefix()} | ${sql.substring(0, 100)}`, ...args);
  }
}