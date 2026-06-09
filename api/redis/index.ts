import { createClient } from 'redis';
const MAX_RETRY = 2;
const redisEnabled = true;

// ==============================
// 内存缓存（自动清理）
// ==============================
const memoryStore = new Map<string, { value: any; expires: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [key, item] of memoryStore) {
    if (item.expires && item.expires < now) {
      memoryStore.delete(key);
    }
  }
}, 3000);

const memoryKV = {
  async get<T>(key: string): Promise<T | null> {
    try {
      const item = memoryStore.get(key);
      if (!item) return null;
      if (item.expires && item.expires < Date.now()) {
        memoryStore.delete(key);
        return null;
      }
      return item.value;
    } catch {
      return null;
    }
  },

  async set(key: string, value: any, exSeconds = 600): Promise<void> {
    try {
      memoryStore.set(key, {
        value,
        expires: exSeconds ? Date.now() + exSeconds * 1000 : 0,
      });
    } catch {}
  },

  async del(key: string): Promise<void> {
    try {
      memoryStore.delete(key);
    } catch {}
  },

  async incr(key: string): Promise<number> {
    try {
      const val = ((await this.get<number>(key)) ?? 0) + 1;
      await this.set(key, val, 60);
      return val;
    } catch {
      return 0;
    }
  },
};

// ==============================
// Redis 客户端（从环境变量读取配置）
// ==============================
let redisClient: ReturnType<typeof createClient> | null = null;
let redisFailed = false;
let connecting = false;

export async function getRedisClient() {
  if (!redisEnabled) return null;
  if (redisFailed) return null;
  if (connecting) return null;
  if (redisClient) return redisClient;

  try {
    connecting = true;

    // 从环境变量读取配置
    const host = process.env.REDIS_HOST!;
    const port = parseInt(process.env.REDIS_PORT!) || 6379;
    const password = process.env.REDIS_PASSWORD!;
    const username = process.env.REDIS_USERNAME || 'default';

    if (!host || !password) {
      console.warn('[KV] Redis 环境变量未配置，使用内存缓存');
      redisFailed = true;
      return null;
    }

    const client = createClient({
      username,
      password,
      socket: { host, port },
    });

    client.on('error', (err) => {
      console.warn('[KV] Redis 错误:', err.message);
      redisFailed = true;
    });

    client.on('end', () => {
      redisFailed = true;
    });

    await client.connect();
    console.log('[KV] ✅ Redis 连接成功');

    redisClient = client;
    return client;
  } catch (err: any) {
    redisFailed = true;
    console.warn('[KV] Redis 连接失败:', err.message);
    return null;
  } finally {
    connecting = false;
  }
}

// ==============================
// 统一 KV 工具
// ==============================
export const kv = {
  async get<T>(key: string): Promise<T | null> {
    const client = await getRedisClient();
    if (!client) return memoryKV.get(key);

    try {
      const data = await client.get(key);
      const result = data ? JSON.parse(data) : null;
      console.log(`[KV] Redis GET ${key} | ${result ? '命中' : '不存在'}`);
      return result;
    } catch {
      redisFailed = true;
      return memoryKV.get(key);
    }
  },

  async set(key: string, value: any, exSeconds = 600): Promise<void> {
    const client = await getRedisClient();
    if (!client) return memoryKV.set(key, value, exSeconds);

    try {
      const val = JSON.stringify(value);
      await client.setEx(key, exSeconds, val);
      console.log(`[KV] Redis SET ${key} | 过期: ${exSeconds}s`);
    } catch {
      redisFailed = true;
      await memoryKV.set(key, value, exSeconds);
    }
  },

  async del(key: string): Promise<void> {
    const client = await getRedisClient();
    if (!client) return memoryKV.del(key);

    try {
      await client.del(key);
      console.log(`[KV] Redis DEL ${key}`);
    } catch {
      redisFailed = true;
      await memoryKV.del(key);
    }
  },

  async incr(key: string): Promise<number> {
    const client = await getRedisClient();
    if (!client) return memoryKV.incr(key);

    try {
      const val = await client.incr(key);
      console.log(`[KV] Redis INCR ${key} = ${val}`);
      return val;
    } catch {
      redisFailed = true;
      return memoryKV.incr(key);
    }
  },
};