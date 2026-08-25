import { useCallback, useEffect, useState } from "react";
import type { AppSettings } from "../../application/appSettings";
import type { PermissionMode } from "../../application/toolProtocol";
import type { ModelConfig } from "../../application/modelProtocol";

export interface UseAppSettingsResult {
    settings: AppSettings | null;
    loading: boolean;
    error: string | null;
    networkEnabled: boolean;
    permissionMode: PermissionMode;
    modelConfig: ModelConfig;
    compressionDefaults: AppSettings["compression"]["defaults"] | null;
    updateNetworkEnabled: (enabled: boolean) => Promise<void>;
    updatePermissionMode: (mode: PermissionMode) => Promise<void>;
    updateModelConfig: (config: Partial<ModelConfig>) => Promise<void>;
    saveModelConfig: (config: ModelConfig) => Promise<boolean>;
    resetSettings: () => Promise<void>;
}

const EMPTY_MODEL_CONFIG: ModelConfig = {
    baseUrl: "",
    model: "",
    stream: true,
    thinking: "disabled",
    maxTokens: 4096,
    temperature: 0.7,
    connectTimeoutMs: 10_000,
    firstByteTimeoutMs: 30_000,
    readTimeoutMs: 60_000,
    totalTimeoutMs: 90_000,
    apiKey: "",
};

export function useAppSettings(): UseAppSettingsResult {
    const [settings, setSettings] = useState<AppSettings | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        console.info("[useAppSettings] 正在从主进程加载设置...");
        window.triMusicAgent.getAppSettings()
            .then((loaded) => {
                if (!active) return;
                console.info("[useAppSettings] 设置加载成功", {
                    networkEnabled: loaded.network.enabled,
                    permissionMode: loaded.security.permissionMode,
                    modelConfigured: Boolean(loaded.model.defaultConfig.baseUrl),
                    workspaceRoot: loaded.workspace.workspaceRoot,
                });
                setSettings(loaded);
                setError(null);
            })
            .catch((err) => {
                if (!active) return;
                const message = err instanceof Error ? err.message : "加载设置失败";
                console.error("[useAppSettings] 设置加载失败", message);
                setError(message);
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => { active = false; };
    }, []);

    const updateNetworkEnabled = useCallback(async (enabled: boolean) => {
        console.info("[useAppSettings] 更新联网开关:", enabled);
        setSettings((prev) => prev ? { ...prev, network: { ...prev.network, enabled } } : prev);
        try {
            await window.triMusicAgent.updateAppSettings({ network: { enabled } });
            console.info("[useAppSettings] 联网开关已保存:", enabled);
        } catch (err) {
            const message = err instanceof Error ? err.message : "保存联网设置失败";
            console.error("[useAppSettings] 保存联网设置失败", message);
            setError(message);
            throw err;
        }
    }, []);

    const updatePermissionMode = useCallback(async (mode: PermissionMode) => {
        console.info("[useAppSettings] 更新权限模式:", mode);
        setSettings((prev) => prev ? { ...prev, security: { ...prev.security, permissionMode: mode } } : prev);
        try {
            await window.triMusicAgent.updateAppSettings({ security: { permissionMode: mode } });
            console.info("[useAppSettings] 权限模式已保存:", mode);
        } catch (err) {
            const message = err instanceof Error ? err.message : "保存权限模式失败";
            console.error("[useAppSettings] 保存权限模式失败", message);
            setError(message);
            throw err;
        }
    }, []);

    const updateModelConfig = useCallback(async (config: Partial<ModelConfig>) => {
        console.info("[useAppSettings] 更新模型配置:", Object.keys(config));
        setSettings((prev) => {
            if (!prev) return prev;
            return { ...prev, model: { ...prev.model, defaultConfig: { ...prev.model.defaultConfig, ...config } } };
        });
        try {
            const { apiKey: _key, ...safeConfig } = config;
            const updated = await window.triMusicAgent.updateAppSettings({ model: { defaultConfig: safeConfig as Omit<ModelConfig, "apiKey"> } });
            setSettings(updated);
            console.info("[useAppSettings] 模型配置已保存");
        } catch (err) {
            const message = err instanceof Error ? err.message : "保存模型配置失败";
            console.error("[useAppSettings] 保存模型配置失败", message);
            setError(message);
            throw err;
        }
    }, []);

    const saveModelConfig = useCallback(async (config: ModelConfig) => {
        console.info("[useAppSettings] 保存模型配置到会话:", config.model);
        try {
            const result = await window.triMusicAgent.saveModelConfig(config);
            console.info("[useAppSettings] 模型配置保存结果:", result);
            return result;
        } catch (err) {
            const message = err instanceof Error ? err.message : "保存模型配置失败";
            console.error("[useAppSettings] 保存模型配置失败", message);
            setError(message);
            return false;
        }
    }, []);

    const resetSettings = useCallback(async () => {
        console.info("[useAppSettings] 重置所有设置为默认值");
        try {
            const reset = await window.triMusicAgent.resetAppSettings();
            setSettings(reset);
            console.info("[useAppSettings] 设置已重置为默认值");
        } catch (err) {
            const message = err instanceof Error ? err.message : "重置设置失败";
            console.error("[useAppSettings] 重置设置失败", message);
            setError(message);
        }
    }, []);

    const networkEnabled = settings?.network.enabled ?? false;
    const permissionMode = settings?.security.permissionMode ?? "standard";
    const modelConfig: ModelConfig = settings
        ? { ...EMPTY_MODEL_CONFIG, ...settings.model.defaultConfig }
        : EMPTY_MODEL_CONFIG;
    const compressionDefaults = settings?.compression.defaults ?? null;

    return {
        settings,
        loading,
        error,
        networkEnabled,
        permissionMode,
        modelConfig,
        compressionDefaults,
        updateNetworkEnabled,
        updatePermissionMode,
        updateModelConfig,
        saveModelConfig,
        resetSettings,
    };
}
