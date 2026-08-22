import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { WorkspaceService, type WorkspaceState } from "../application/workspaceService";
import { JsonSettingsRepository } from "../infrastructure/settingsRepository";
import { FileSystemWorkspaceRepository } from "../infrastructure/workspaceRepository";

let mainWindow: BrowserWindow | null = null;
let workspaceService: WorkspaceService;

function installationDirectory(): string {
  return app.isPackaged ? path.dirname(app.getPath("exe")) : app.getAppPath();
}

function publishState(state: WorkspaceState): WorkspaceState {
  mainWindow?.webContents.send("app:initialization-state", state);
  return state;
}

function registerIpc(): void {
  ipcMain.handle("app:get-initialization-state", () => workspaceService.getState());
  ipcMain.handle("workspace:choose-root", async () => {
    if (!mainWindow) return workspaceService.getState();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择工作数据根目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return workspaceService.getState();
    }
    return publishState(await workspaceService.chooseWorkspaceRoot(result.filePaths[0]));
  });
  ipcMain.handle("session:create", async () => publishState(await workspaceService.createSession()));
  ipcMain.handle("session:select", async (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string") return workspaceService.getState();
    return publishState(await workspaceService.selectSession(sessionId));
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: "#f4f7fb",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  await mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  publishState(workspaceService.getState());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function bootstrap(): Promise<void> {
  workspaceService = new WorkspaceService(
    new FileSystemWorkspaceRepository(),
    new JsonSettingsRepository(path.join(app.getPath("userData"), "settings.json")),
    installationDirectory(),
  );
  registerIpc();
  await workspaceService.initialize();
  await createWindow();
}

void app.whenReady().then(bootstrap).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "应用初始化失败。";
  dialog.showErrorBox("TriMusicAgent 初始化失败", message);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && workspaceService) void createWindow();
});
