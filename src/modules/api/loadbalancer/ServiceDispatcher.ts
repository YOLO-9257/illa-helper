/**
 * 服务调度器
 *
 * 负责管理API配置池和实现负载均衡调度。
 * 支持轮询(Round-Robin)策略，并提供配置状态追踪功能。
 */

import { ApiConfigItem } from '../../shared/types/api';
import { StorageService, StorageEventType } from '../../core/storage';

/**
 * 服务调度器类
 * 采用单例模式，管理API配置池的负载均衡调度
 */
export class ServiceDispatcher {
  private static instance: ServiceDispatcher | null = null;

  // 轮询索引（全局轮询状态）
  private currentIndex: number = 0;

  // 存储服务引用
  private storageService: StorageService;

  // 运行时状态缓存（避免频繁读写存储）
  private runtimeStatusCache: Map<
    string,
    {
      lastUsed?: number;
      successCount: number;
      failureCount: number;
      lastError?: { code: number; message: string; timestamp: number };
      cooldownUntil?: number;
    }
  > = new Map();

  // 配置缓存
  private configCache: ApiConfigItem[] | null = null;

  // 启用配置缓存（性能优化：避免每次过滤）
  private enabledConfigsCache: Map<string, ApiConfigItem[]> = new Map();
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL_MS = 1000; // 缓存有效期 1 秒

  private constructor() {
    this.storageService = StorageService.getInstance();

    // 监听配置变更事件，失效所有缓存
    const invalidateCache = () => {
      this.configCache = null;
      this.enabledConfigsCache.clear();
      this.cacheTimestamp = 0;
    };

    this.storageService.addEventListener(
      StorageEventType.SETTINGS_SAVED,
      invalidateCache,
    );
    this.storageService.addEventListener(
      StorageEventType.API_CONFIG_ADDED,
      invalidateCache,
    );
    this.storageService.addEventListener(
      StorageEventType.API_CONFIG_UPDATED,
      invalidateCache,
    );
    this.storageService.addEventListener(
      StorageEventType.DATA_CLEARED,
      invalidateCache,
    );
    this.storageService.addEventListener(
      StorageEventType.SETTINGS_LOADED,
      invalidateCache,
    );

    // 监听配置删除事件，清理对应的运行时状态缓存（避免内存泄漏）
    this.storageService.addEventListener(
      StorageEventType.API_CONFIG_REMOVED,
      (event) => {
        invalidateCache();
        const configId = event.data?.configId;
        if (configId && this.runtimeStatusCache.has(configId)) {
          this.runtimeStatusCache.delete(configId);
        }
      },
    );
  }

  /**
   * 获取单例实例
   */
  static getInstance(): ServiceDispatcher {
    if (!ServiceDispatcher.instance) {
      ServiceDispatcher.instance = new ServiceDispatcher();
    }
    return ServiceDispatcher.instance;
  }

  /**
   * 获取所有启用的配置（带智能缓存）
   * @param providerId 可选，按服务商ID过滤
   * @returns 启用的配置列表
   */
  async getEnabledConfigs(providerId?: string): Promise<ApiConfigItem[]> {
    const now = Date.now();
    const cacheKey = providerId || '__all__';

    // 检查缓存是否有效
    if (
      this.cacheTimestamp > 0 &&
      now - this.cacheTimestamp < this.CACHE_TTL_MS &&
      this.enabledConfigsCache.has(cacheKey)
    ) {
      // 快速路径：使用缓存的结果，但仍需检查冷却状态
      const cachedConfigs = this.enabledConfigsCache.get(cacheKey)!;
      return this.filterCooldownConfigs(cachedConfigs, now);
    }

    // 缓存未命中，重新获取
    let apis: ApiConfigItem[];
    if (this.configCache) {
      apis = this.configCache;
    } else {
      const settings = await this.storageService.getUserSettings();
      this.configCache = settings.apiConfigs;
      apis = this.configCache;
    }

    // 过滤已启用的配置
    let configs = apis.filter((c) => c.enabled !== false);

    // 按服务商过滤
    if (providerId) {
      configs = configs.filter((c) => c.provider === providerId);
    }

    // 更新缓存
    this.enabledConfigsCache.set(cacheKey, configs);
    this.cacheTimestamp = now;

    // 过滤冷却中的配置
    return this.filterCooldownConfigs(configs, now);
  }

  /**
   * 过滤冷却中的配置（内联优化）
   */
  private filterCooldownConfigs(
    configs: ApiConfigItem[],
    now: number,
  ): ApiConfigItem[] {
    // 快速路径：如果没有任何配置在冷却中，直接返回
    if (this.runtimeStatusCache.size === 0) {
      return configs;
    }

    // 快速路径：只有一个配置时，直接检查
    if (configs.length === 1) {
      const status = this.runtimeStatusCache.get(configs[0].id);
      if (!status?.cooldownUntil || now >= status.cooldownUntil) {
        return configs;
      }
      return [];
    }

    // 多配置过滤
    return configs.filter((c) => {
      const cachedStatus = this.runtimeStatusCache.get(c.id);
      return !cachedStatus?.cooldownUntil || now >= cachedStatus.cooldownUntil;
    });
  }

  /**
   * 使用轮询策略获取下一个配置
   * @param configs 可用的配置列表
   * @returns 下一个配置，如果列表为空则返回null
   */
  getNextConfig(configs: ApiConfigItem[]): ApiConfigItem | null {
    if (configs.length === 0) {
      return null;
    }

    const config = configs[this.currentIndex % configs.length];
    this.currentIndex++;

    // 防止索引溢出
    if (this.currentIndex >= Number.MAX_SAFE_INTEGER) {
      this.currentIndex = 0;
    }

    return config;
  }

  /**
   * 构建故障转移队列
   * 将轮询选中的配置放在队列头部，其他配置作为备份
   * @param configs 可用的配置列表
   * @returns 故障转移队列
   */
  buildFailoverQueue(configs: ApiConfigItem[]): ApiConfigItem[] {
    if (configs.length === 0) {
      return [];
    }

    const preferred = this.getNextConfig(configs);
    if (!preferred) {
      return [];
    }

    // 按优先级排序其他配置（如果有优先级字段）
    const others = configs
      .filter((c) => c.id !== preferred.id)
      .sort((a, b) => (a.priority || 0) - (b.priority || 0));

    return [preferred, ...others];
  }

  /**
   * 标记配置调用失败，进入冷却期
   * @param configId 配置ID
   * @param error 错误信息
   * @param cooldownDuration 冷却时间（毫秒），默认60秒
   */
  markConfigError(
    configId: string,
    error: { code: number; message: string },
    cooldownDuration: number = 60000,
  ): void {
    const existing = this.runtimeStatusCache.get(configId) || {
      successCount: 0,
      failureCount: 0,
    };

    this.runtimeStatusCache.set(configId, {
      ...existing,
      failureCount: existing.failureCount + 1,
      lastError: {
        code: error.code,
        message: error.message,
        timestamp: Date.now(),
      },
      cooldownUntil: Date.now() + cooldownDuration,
    });
  }

  /**
   * 标记配置调用成功
   * @param configId 配置ID
   */
  markConfigSuccess(configId: string): void {
    const existing = this.runtimeStatusCache.get(configId) || {
      successCount: 0,
      failureCount: 0,
    };

    this.runtimeStatusCache.set(configId, {
      ...existing,
      lastUsed: Date.now(),
      successCount: existing.successCount + 1,
      cooldownUntil: undefined, // 成功后清除冷却
    });
  }

  /**
   * 重置轮询索引
   */
  resetIndex(): void {
    this.currentIndex = 0;
  }

  /**
   * 清除运行时状态缓存
   */
  clearRuntimeStatusCache(): void {
    this.runtimeStatusCache.clear();
  }

  /**
   * 获取配置的运行时统计信息
   * @param configId 配置ID
   */
  getConfigStats(configId: string): {
    successCount: number;
    failureCount: number;
    lastUsed?: number;
    isInCooldown: boolean;
  } | null {
    const status = this.runtimeStatusCache.get(configId);
    if (!status) {
      return null;
    }

    return {
      successCount: status.successCount,
      failureCount: status.failureCount,
      lastUsed: status.lastUsed,
      isInCooldown: !!(
        status.cooldownUntil && Date.now() < status.cooldownUntil
      ),
    };
  }

  /**
   * 获取当前轮询索引（用于调试）
   */
  getCurrentIndex(): number {
    return this.currentIndex;
  }

  /**
   * 获取所有配置的运行时状态摘要（用于系统诊断）
   * @param configs 配置列表
   * @returns 每个配置的状态信息数组
   */
  getAllConfigsStatus(configs: ApiConfigItem[]): {
    configId: string;
    configName: string;
    provider: string;
    enabled: boolean;
    successCount: number;
    failureCount: number;
    lastUsed?: number;
    isInCooldown: boolean;
    cooldownRemainingMs?: number;
    lastError?: { code: number; message: string; timestamp: number };
    keyCount: number;
  }[] {
    const now = Date.now();
    return configs.map((config) => {
      const status = this.runtimeStatusCache.get(config.id);
      const isEnabled = config.enabled !== false;

      // 解析 API Key 数量
      const keys = this.parseApiKeys(config.config?.apiKey || '');

      let cooldownRemainingMs: number | undefined;
      if (status?.cooldownUntil && now < status.cooldownUntil) {
        cooldownRemainingMs = status.cooldownUntil - now;
      }

      return {
        configId: config.id,
        configName: config.name,
        provider: config.provider,
        enabled: isEnabled,
        successCount: status?.successCount || 0,
        failureCount: status?.failureCount || 0,
        lastUsed: status?.lastUsed,
        isInCooldown: !!(status?.cooldownUntil && now < status.cooldownUntil),
        cooldownRemainingMs,
        lastError: status?.lastError,
        keyCount: keys.length,
      };
    });
  }

  // ========== 多 Key 轮询支持 ==========

  /**
   * 解析 API Key 字符串，支持逗号或换行分隔
   * @param apiKeyRaw 原始 Key 字符串
   * @returns 解析后的 Key 数组
   */
  parseApiKeys(apiKeyRaw: string): string[] {
    if (!apiKeyRaw) return [];
    return apiKeyRaw
      .split(/[,\n\r]/)
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
  }

  /**
   * 获取下一个可用的 API Key（轮询 + 冷却跳过）
   * @param configId 配置 ID
   * @param apiKeyRaw 原始 Key 字符串（可能包含多个）
   * @returns 可用的 Key，如果全部在冷却中则返回 null
   */
  getNextAvailableApiKey(configId: string, apiKeyRaw: string): string | null {
    const keys = this.parseApiKeys(apiKeyRaw);
    if (keys.length === 0) return null;
    if (keys.length === 1) return keys[0]; // 单 Key 直接返回

    const now = Date.now();
    const status = this.runtimeStatusCache.get(configId) || {
      successCount: 0,
      failureCount: 0,
    };

    // 获取或初始化 keyStatuses
    let keyStatuses = (status as any).keyStatuses as
      | Map<string, { cooldownUntil?: number }>
      | undefined;
    if (!keyStatuses) {
      keyStatuses = new Map();
      (status as any).keyStatuses = keyStatuses;
      this.runtimeStatusCache.set(configId, status);
    }

    // 获取当前轮询索引
    const rotationIndex = (status as any).keyRotationIndex || 0;
    const startIndex = rotationIndex;

    // 尝试找到一个不在冷却中的 Key
    for (let i = 0; i < keys.length; i++) {
      const idx = (startIndex + i) % keys.length;
      const key = keys[idx];
      const keyStatus = keyStatuses.get(key);

      if (!keyStatus?.cooldownUntil || now >= keyStatus.cooldownUntil) {
        // 找到可用 Key，更新索引
        (status as any).keyRotationIndex = (idx + 1) % keys.length;
        this.runtimeStatusCache.set(configId, status);
        console.log(
          `[ServiceDispatcher] 使用 Key #${idx + 1}/${keys.length} (${key.substring(0, 8)}...)`,
        );
        return key;
      }
    }

    // 所有 Key 都在冷却中
    console.warn('[ServiceDispatcher] 所有 API Key 均在冷却中');
    return null;
  }

  /**
   * 标记某个 API Key 调用失败，进入冷却期
   * @param configId 配置 ID
   * @param apiKey 失败的 Key
   * @param error 错误信息
   * @param cooldownDuration 冷却时间（毫秒），默认 60 秒
   */
  markApiKeyError(
    configId: string,
    apiKey: string,
    error: { code: number; message: string },
    cooldownDuration: number = 60000,
  ): void {
    const status = this.runtimeStatusCache.get(configId) || {
      successCount: 0,
      failureCount: 0,
    };

    let keyStatuses = (status as any).keyStatuses as
      | Map<
          string,
          {
            successCount: number;
            failureCount: number;
            cooldownUntil?: number;
            lastError?: { code: number; message: string; timestamp: number };
          }
        >
      | undefined;
    if (!keyStatuses) {
      keyStatuses = new Map();
      (status as any).keyStatuses = keyStatuses;
    }

    const existing = keyStatuses.get(apiKey) || {
      successCount: 0,
      failureCount: 0,
    };
    keyStatuses.set(apiKey, {
      ...existing,
      failureCount: existing.failureCount + 1,
      cooldownUntil: Date.now() + cooldownDuration,
      lastError: {
        code: error.code,
        message: error.message,
        timestamp: Date.now(),
      },
    });

    this.runtimeStatusCache.set(configId, status);
    console.log(
      `[ServiceDispatcher] Key ${apiKey.substring(0, 8)}... 进入冷却期 ${cooldownDuration / 1000}s`,
    );
  }

  /**
   * 标记某个 API Key 调用成功
   * @param configId 配置 ID
   * @param apiKey 成功的 Key
   */
  markApiKeySuccess(configId: string, apiKey: string): void {
    const status = this.runtimeStatusCache.get(configId) || {
      successCount: 0,
      failureCount: 0,
    };

    let keyStatuses = (status as any).keyStatuses as
      | Map<
          string,
          { successCount: number; failureCount: number; cooldownUntil?: number }
        >
      | undefined;
    if (!keyStatuses) {
      keyStatuses = new Map();
      (status as any).keyStatuses = keyStatuses;
    }

    const existing = keyStatuses.get(apiKey) || {
      successCount: 0,
      failureCount: 0,
    };
    keyStatuses.set(apiKey, {
      ...existing,
      successCount: existing.successCount + 1,
      cooldownUntil: undefined, // 成功后清除冷却
    });

    this.runtimeStatusCache.set(configId, status);
  }
}

// 导出单例实例
export const serviceDispatcher = ServiceDispatcher.getInstance();
