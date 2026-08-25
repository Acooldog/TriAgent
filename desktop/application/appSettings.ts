import type { ModelConfig } from "./modelProtocol";
import type { ExecutionLimits } from "./executionBudget";
import type { CompressionOptions } from "./contextCompression";
import type { PermissionMode } from "./toolProtocol";

export interface WindowSettings {
    width: number;
    height: number;
    minWidth: number;
    minHeight: number;
}

export interface AppSettings {
    workspace: {
        workspaceRoot: string | null;
    };
    model: {
        defaultConfig: Omit<ModelConfig, "apiKey">;
    };
    execution: {
        limits: ExecutionLimits;
    };
    compression: {
        defaults: CompressionOptions;
    };
    window: WindowSettings;
    worker: {
        scriptPath: string;
    };
    network: {
        enabled: boolean;
    };
    security: {
        permissionMode: PermissionMode;
    };
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
    workspace: {
        workspaceRoot: null,
    },
    model: {
        defaultConfig: {
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
        },
    },
    execution: {
        limits: {
            maxStepRetries: 2,
            maxModelTurns: 8,
            maxToolCalls: 16,
            totalTimeoutMs: 15 * 60 * 1_000,
        },
    },
    compression: {
        defaults: {
            thresholdTokens: 1200,
            preserveRecentMessages: 4,
            markdownThresholdTokens: 2400,
            writeMarkdown: false,
        },
    },
    window: {
        width: 1080,
        height: 720,
        minWidth: 760,
        minHeight: 520,
    },
    worker: {
        scriptPath: "",
    },
    network: {
        enabled: false,
    },
    security: {
        permissionMode: "standard",
    },
};

export interface AppSettingsRepository {
    load(): Promise<AppSettings>;
    save(settings: Partial<AppSettings>): Promise<void>;
    reset(): Promise<AppSettings>;
}
