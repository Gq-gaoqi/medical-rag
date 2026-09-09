/**
 * 检索结果缓存层（server/cache.ts）
 * ------------------------------------------------------------
 * 目标：对「相同查询」直接复用检索结果，降低向量库 / 重排 / LLM 的重复开销。
 *
 * 设计原则（贴合项目「开箱即用 + 优雅降级」风格）：
 *  - 默认走进程内 LRU 风格内存缓存，零依赖，单实例部署即可生效；
 *  - 配置了 REDIS_URL 时自动升级为 Redis 共享缓存（多实例 / 多副本可用）；
 *  - 未安装 ioredis / Redis 不可达 / 调用异常 → 全部静默降级为内存缓存，绝不影响主链路。
 *  - CACHE_MODE=off 可完全关闭缓存（如评估时要求纯干净检索）。
 */
import { createHash } from 'crypto';

interface CachedItem {
  value: unknown;
  expires: number;
}

/** 进程内内存缓存（兜底 / 默认） */
class MemoryCache {
  private map = new Map<string, CachedItem>();
  get(key: string): unknown | null {
    const it = this.map.get(key);
    if (!it) return null;
    if (it.expires < Date.now()) {
      this.map.delete(key);
      return null;
    }
    return it.value;
  }
  set(key: string, value: unknown, ttlMs: number): void {
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    // 简单上限保护，防止内存无限增长
    if (this.map.size > 5000) {
      const first = this.map.keys().next().value;
      if (first) this.map.delete(first);
    }
  }
  clear(): void {
    this.map.clear();
  }
}

const memory = new MemoryCache();
let redisClient: any = null;
let redisResolved = false;

function cacheDisabled(): boolean {
  return process.env.CACHE_MODE === 'off';
}

/** 懒加载 Redis 客户端（仅当 REDIS_URL 存在且 ioredis 可加载时） */
async function getRedis(): Promise<any | null> {
  if (cacheDisabled()) return null;
  if (redisResolved) return redisClient;
  redisResolved = true;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    // ioredis 为可选依赖：仅在启用 Redis 时才动态加载，避免默认安装。
    // 用变量形式动态 import，让 TS 跳过模块解析（未安装也不报错）。
    const redisPkg = 'ioredis';
    const mod: any = await import(redisPkg);
    const Redis = mod.default ?? mod;
    const client = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
    client.on('error', () => {
      /* 连接错误时静默降级为内存缓存 */
    });
    await client.connect().catch(() => {
      /* 连接失败不抛，回退内存 */
    });
    redisClient = client;
    return client;
  } catch {
    return null;
  }
}

/** 读取缓存，未命中返回 null */
export async function getCache(key: string): Promise<unknown | null> {
  if (cacheDisabled()) return null;
  const r = await getRedis();
  if (r) {
    try {
      const raw = await r.get(key);
      if (!raw) return null;
      const item = JSON.parse(raw) as CachedItem;
      if (item.expires < Date.now()) {
        await r.del(key).catch(() => {});
        return null;
      }
      return item.value;
    } catch {
      /* 落到内存缓存 */
    }
  }
  return memory.get(key);
}

/** 写入缓存，TTL 默认 10 分钟 */
export async function setCache(key: string, value: unknown, ttlMs = 10 * 60 * 1000): Promise<void> {
  if (cacheDisabled()) return;
  const r = await getRedis();
  if (r) {
    try {
      await r.set(key, JSON.stringify({ value, expires: Date.now() + ttlMs }), 'PX', ttlMs);
      return;
    } catch {
      /* 落到内存缓存 */
    }
  }
  memory.set(key, value, ttlMs);
}

/** 生成稳定缓存键（对查询 + 关键配置取哈希，避免缓存串味） */
export function cacheKey(...parts: string[]): string {
  const h = createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
  return `rag:search:${h}`;
}

/** 清空内存缓存（测试 / 运维用） */
export function clearCache(): void {
  memory.clear();
}
