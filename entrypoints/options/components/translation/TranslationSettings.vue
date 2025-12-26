<template>
  <div class="space-y-6">
    <!-- 当前配置概览 (可选，作为仪表盘) -->
    <Card>
      <CardHeader>
        <CardTitle>
          <div class="flex items-center gap-2">
            <h2 class="text-2xl font-bold text-foreground">
              {{ $t('translationSettings.title') }}
            </h2>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent class="space-y-4">
        <!-- API超时时间配置 -->
        <div class="bg-muted/50 rounded-lg p-4 border border-border/50">
          <div class="flex items-center gap-2 mb-3">
            <div
              class="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center"
            >
              <svg
                class="h-4 w-4 text-primary"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
            <h3 class="text-lg font-semibold text-foreground">
              {{ $t('translationSettings.apiRequestSettings') }}
            </h3>
          </div>

          <div class="space-y-3">
            <div class="space-y-2">
              <Label
                for="api-timeout"
                class="text-sm font-medium flex items-center gap-2"
              >
                {{ $t('translationSettings.timeoutSeconds') }}
                <span
                  class="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                >
                  {{ $t('translationSettings.globalSetting') }}
                </span>
              </Label>
              <div class="relative">
                <Input
                  id="api-timeout"
                  type="number"
                  :model-value="(settings.apiRequestTimeout / 1000).toFixed(3)"
                  @update:model-value="
                    settings.apiRequestTimeout = Number($event || 0) * 1000
                  "
                  min="0"
                  step="0.001"
                  class="pr-12"
                />
                <div
                  class="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none"
                >
                  <span class="text-sm text-muted-foreground">
                    {{ $t('translationSettings.seconds') }}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- 配置列表组件 -->
    <ApiConfigList
      :configs="settings.apiConfigs"
      :active-id="settings.activeApiConfigId"
      :settings="settings"
      @add="openAddDialog"
      @edit="openEditDialog"
      @delete="handleDelete"
      @toggle="handleToggle"
      @set-active="handleSetActive"
    />

    <!-- 配置编辑表单 -->
    <ApiConfigForm
      v-if="showDialog"
      :initial-config="editingConfig"
      :settings="settings"
      @save="handleSave"
      @cancel="closeDialog"
    />

    <!-- 系统诊断工具 -->
    <Card class="border-dashed border-muted-foreground/30 bg-muted/20 mt-8">
      <CardHeader class="pb-2">
        <CardTitle
          class="text-base text-muted-foreground flex items-center justify-between flex-wrap gap-2"
        >
          <div class="flex items-center gap-2">
            <ActivityIcon class="h-4 w-4" />
            <span>{{ $t('translationSettings.diagnostics', '系统诊断') }}</span>
          </div>
          <div class="flex gap-2 flex-wrap">
            <Button
              @click="showConfigStatus"
              size="sm"
              variant="outline"
              :disabled="isRunningDiagnostics || isTestingConfigs"
            >
              <ClipboardListIcon class="h-4 w-4 mr-1.5" />
              查看配置状态
            </Button>
            <Button
              @click="testAllConfigs"
              size="sm"
              variant="default"
              :disabled="isTestingConfigs || settings.apiConfigs.length === 0"
            >
              <span v-if="isTestingConfigs" class="animate-spin mr-2">⏳</span>
              <ZapIcon v-else class="h-4 w-4 mr-1.5" />
              检测所有 API
            </Button>
            <Button
              @click="runDiagnostics"
              size="sm"
              variant="outline"
              :disabled="isRunningDiagnostics"
            >
              <span v-if="isRunningDiagnostics" class="animate-spin mr-2">
                ⏳
              </span>
              单元测试
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent v-if="diagnosticLogs.length > 0">
        <div
          class="bg-black/90 p-3 rounded-md font-mono text-xs overflow-y-auto max-h-80 space-y-1"
        >
          <div
            v-for="(log, idx) in diagnosticLogs"
            :key="idx"
            class="text-white break-words whitespace-pre-wrap"
            :class="{
              'text-green-400': log.includes('✅') || log.includes('[成功]'),
              'text-red-400': log.includes('❌') || log.includes('[失败]'),
              'text-yellow-400': log.includes('⚠️') || log.includes('[冷却]'),
              'text-blue-400': log.includes('ℹ️') || log.includes('[信息]'),
              'text-gray-400': log.includes('---'),
            }"
          >
            {{ log }}
          </div>
        </div>
        <div class="flex justify-end mt-2">
          <Button
            @click="clearDiagnosticLogs"
            size="sm"
            variant="ghost"
            class="text-xs text-muted-foreground"
          >
            清空日志
          </Button>
        </div>
      </CardContent>
    </Card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { StorageService } from '@/src/modules/core/storage';
import {
  UserSettings,
  DEFAULT_SETTINGS,
  ApiConfigItem,
  ApiConfig,
} from '@/src/modules/shared/types';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import ApiConfigList from '../api/ApiConfigList.vue';
import ApiConfigForm from '../api/ApiConfigForm.vue';
import { LoadBalancerTestSuite } from '@/src/modules/api/loadbalancer/tests/LoadBalancerTestSuite';
import { ServiceDispatcher } from '@/src/modules/api/loadbalancer/ServiceDispatcher';
import { testApiConnection } from '@/src/utils';
import {
  Activity as ActivityIcon,
  ClipboardList as ClipboardListIcon,
  Zap as ZapIcon,
} from 'lucide-vue-next';

const { t } = useI18n();
const settings = ref<UserSettings>({ ...DEFAULT_SETTINGS });
const storageService = StorageService.getInstance();

const showDialog = ref(false);
const editingConfig = ref<ApiConfigItem | null>(null);

const emit = defineEmits<{
  saveMessage: [message: string];
}>();

// 加载设置
const loadSettings = async () => {
  try {
    settings.value = await storageService.getUserSettings();
  } catch (error) {
    console.error(t('errors.loadSettingsFailed'), error);
  }
};

onMounted(async () => {
  await loadSettings();
});

// 防抖函数
function debounce<T extends (...args: any[]) => any>(fn: T, delay: number): T {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  return ((...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  }) as T;
}

// 防抖保存函数
const debouncedSave = debounce(async (newSettings: UserSettings) => {
  try {
    await storageService.saveUserSettings(newSettings);
    notifyConfigChange();
  } catch (error) {
    console.error(t('errors.saveSettingsFailed'), error);
  }
}, 300);

// 自动保存（带防抖）
watch(
  settings,
  (newSettings) => {
    debouncedSave(newSettings);
  },
  { deep: true },
);

const notifyConfigChange = () => {
  try {
    browser.runtime.sendMessage({
      type: 'settings_updated',
      settings: settings.value,
    });
  } catch (error) {
    console.error(t('errors.notifyConfigChangeFailed'), error);
  }
};

// Handlers
const openAddDialog = () => {
  editingConfig.value = null;
  showDialog.value = true;
};

const openEditDialog = (config: ApiConfigItem) => {
  editingConfig.value = config;
  showDialog.value = true;
};

const closeDialog = () => {
  showDialog.value = false;
  editingConfig.value = null;
};

const handleSave = async (data: {
  name: string;
  provider: string;
  config: ApiConfig;
  weight: number;
}) => {
  try {
    if (editingConfig.value) {
      // 更新
      // 注意：StorageService.updateApiConfig 目前不支持 weight 和 enabled。
      // 我们需要手动更新，或者扩展 StorageService。
      // 鉴于 StorageService.updateApiConfig 只接受 name, provider, config
      // 我们在这里直接操作 settings 数组然后保存，或者扩展 StorageService。
      // 为了保持一致性，我们先调用 updateApiConfig，然后手动补丁 weight。
      // 更好的方式是直接操作 settings.value并保存。

      const index = settings.value.apiConfigs.findIndex(
        (c) => c.id === editingConfig.value!.id,
      );
      if (index !== -1) {
        settings.value.apiConfigs[index] = {
          ...settings.value.apiConfigs[index],
          name: data.name,
          provider: data.provider,
          config: data.config,
          weight: data.weight,
          updatedAt: Date.now(),
        };
        // watch 会自动保存
        emit('saveMessage', '配置已更新');
      }
    } else {
      // 新增
      // 同样的，addApiConfig 不支持 weight。
      // 我们手动构建一个新的 item 并 push
      const newItem: ApiConfigItem = {
        id: `config-${Date.now()}`,
        name: data.name,
        provider: data.provider,
        config: data.config,
        isDefault: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        enabled: true,
        weight: data.weight,
      };
      settings.value.apiConfigs.push(newItem);
      // 如果是第一个配置，设为默认
      if (settings.value.apiConfigs.length === 1) {
        settings.value.activeApiConfigId = newItem.id;
      }
      emit('saveMessage', '配置已添加');
    }
    closeDialog();
  } catch (e) {
    console.error('保存失败', e);
  }
};

const handleDelete = async (id: string) => {
  if (!confirm('确定要删除这个配置吗？')) return;
  settings.value.apiConfigs = settings.value.apiConfigs.filter(
    (c) => c.id !== id,
  );
  // 如果删除了默认配置，重置默认
  if (settings.value.activeApiConfigId === id) {
    settings.value.activeApiConfigId = settings.value.apiConfigs[0]?.id || '';
  }
  emit('saveMessage', '配置已删除');
};

const handleToggle = async (id: string, enabled: boolean) => {
  const config = settings.value.apiConfigs.find((c) => c.id === id);
  if (config) {
    config.enabled = enabled;
  }
};

const handleSetActive = (id: string) => {
  settings.value.activeApiConfigId = id;
  // 确保启用
  const config = settings.value.apiConfigs.find((c) => c.id === id);
  if (config) config.enabled = true;

  emit('saveMessage', '默认配置已更新');
};

// 诊断测试
const isRunningDiagnostics = ref(false);
const isTestingConfigs = ref(false);
const diagnosticLogs = ref<string[]>([]);

const logMessage = (message: string) => {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  diagnosticLogs.value.push(`[${timestamp}] ${message}`);
};

const clearDiagnosticLogs = () => {
  diagnosticLogs.value = [];
};

// 查看当前配置的运行时状态
const showConfigStatus = async () => {
  diagnosticLogs.value = [];
  const dispatcher = ServiceDispatcher.getInstance();
  const configs = settings.value.apiConfigs;

  logMessage('ℹ️ ===== 当前 API 配置运行时状态 =====');
  logMessage(`ℹ️ 配置总数: ${configs.length}`);

  if (configs.length === 0) {
    logMessage('⚠️ 暂无配置的 API');
    return;
  }

  const statusList = dispatcher.getAllConfigsStatus(configs);
  const enabledCount = statusList.filter((s) => s.enabled).length;
  const availableCount = statusList.filter(
    (s) => s.enabled && !s.isInCooldown,
  ).length;

  logMessage(`ℹ️ 已启用: ${enabledCount}，当前可用: ${availableCount}`);
  logMessage('-------------------------------------------');

  for (const status of statusList) {
    const enabledTag = status.enabled ? '✅ 已启用' : '❌ 已禁用';
    const cooldownTag = status.isInCooldown
      ? `⚠️ [冷却中: ${Math.ceil((status.cooldownRemainingMs || 0) / 1000)}s]`
      : '';
    const keyInfo = status.keyCount > 1 ? `(${status.keyCount} Keys)` : '';

    logMessage(`📌 ${status.configName} [${status.provider}] ${keyInfo}`);
    logMessage(`   状态: ${enabledTag} ${cooldownTag}`);
    logMessage(`   成功/失败: ${status.successCount}/${status.failureCount}`);

    if (status.lastUsed) {
      const lastUsedTime = new Date(status.lastUsed).toLocaleString('zh-CN');
      logMessage(`   最后使用: ${lastUsedTime}`);
    }

    if (status.lastError) {
      const errorTime = new Date(status.lastError.timestamp).toLocaleTimeString(
        'zh-CN',
      );
      logMessage(`   ❌ 最后错误 [${errorTime}]: ${status.lastError.message}`);
    }

    logMessage('');
  }

  logMessage(`ℹ️ 当前轮询索引: ${dispatcher.getCurrentIndex()}`);
  emit(
    'saveMessage',
    `状态查看完成：${availableCount}/${enabledCount} 配置可用`,
  );
};

// 检测所有真实 API 配置
const testAllConfigs = async () => {
  isTestingConfigs.value = true;
  diagnosticLogs.value = [];

  const configs = settings.value.apiConfigs;
  const timeout = settings.value.apiRequestTimeout || 30000;

  logMessage('ℹ️ ===== 开始检测所有 API 配置 =====');
  logMessage(`ℹ️ 配置数量: ${configs.length}，超时: ${timeout / 1000}s`);
  logMessage('-------------------------------------------');

  let successCount = 0;
  let failCount = 0;

  for (const config of configs) {
    const keyCount = (config.config?.apiKey || '')
      .split(/[,\n\r]/)
      .filter((k: string) => k.trim()).length;
    const keyInfo = keyCount > 1 ? `(${keyCount} Keys)` : '';

    logMessage(`🔍 测试: ${config.name} [${config.provider}] ${keyInfo}`);

    if (config.enabled === false) {
      logMessage(`   ⚠️ 已禁用，跳过测试`);
      continue;
    }

    try {
      const startTime = Date.now();
      const result = await testApiConnection(config, timeout);
      const duration = Date.now() - startTime;

      if (result.success) {
        successCount++;
        logMessage(`   ✅ [成功] ${result.message || 'OK'} (${duration}ms)`);
        if (result.model) {
          logMessage(`   📦 模型: ${result.model}`);
        }
      } else {
        failCount++;
        logMessage(
          `   ❌ [失败] ${result.message || '未知错误'} (${duration}ms)`,
        );
      }
    } catch (e: any) {
      failCount++;
      logMessage(`   ❌ [异常] ${e.message}`);
    }

    logMessage('');
  }

  logMessage('-------------------------------------------');
  logMessage(`ℹ️ 检测完成：✅ 成功 ${successCount}，❌ 失败 ${failCount}`);

  emit('saveMessage', `API 检测完成：${successCount} 成功，${failCount} 失败`);
  isTestingConfigs.value = false;
};

// 运行负载均衡单元测试
const runDiagnostics = async () => {
  isRunningDiagnostics.value = true;
  diagnosticLogs.value = [];
  try {
    logMessage('ℹ️ ===== 负载均衡单元测试 =====');
    const suite = new LoadBalancerTestSuite();
    const result = await suite.run();
    diagnosticLogs.value = [...diagnosticLogs.value, ...result.logs];
    if (result.failed > 0) {
      emit('saveMessage', `单元测试完成：${result.failed} 项测试失败`);
    } else {
      emit('saveMessage', `单元测试完成：全部通过`);
    }
  } catch (e: any) {
    console.error(e);
    logMessage(`❌ 执行异常: ${e.message}`);
  } finally {
    isRunningDiagnostics.value = false;
  }
};
</script>
