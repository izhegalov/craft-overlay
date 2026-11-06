import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, screen, shell } from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { loadSettings, sanitizeSettings, saveSettings, type Settings } from './store';
import {
  baseAdvice,
  checkItem,
  fetchPrices,
  priceRows,
  pricesAreStale,
  readTarget,
  summarizeTarget,
} from './targets';

const CAPTURE_HOTKEY = 'Alt+F';
const HIDE_OVERLAY_HOTKEY = 'Alt+Shift+F';
const TARGET_HOTKEY = 'Alt+G';

const OVERLAY_WIDTH = 480;
const OVERLAY_MAX_HEIGHT = 760;

const execFileAsync = promisify(execFile);

/**
 * Отправляет в активное окно Ctrl+Alt+C (advanced item copy).
 * Electron не умеет отправлять ввод другим приложениям, поэтому используем
 * Win32 keybd_event через PowerShell. Команда статическая — инъекции нет.
 */
const SEND_ADVANCED_COPY_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CraftOverlayKeyboard {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
[CraftOverlayKeyboard]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 30
[CraftOverlayKeyboard]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 30
[CraftOverlayKeyboard]::keybd_event(0x43, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 70
[CraftOverlayKeyboard]::keybd_event(0x43, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 20
[CraftOverlayKeyboard]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 20
[CraftOverlayKeyboard]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
`;

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let overlayReady: Promise<void> | null = null;
let captureInProgress = false;
let lastOverlay: { channel: string; payload: unknown } | null = null;
let settings: Settings;

app.setAppUserModelId('com.craftoverlay.app');

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (overlayWindow?.isVisible()) {
    overlayWindow.moveTop();
  } else if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 840,
    minWidth: 780,
    minHeight: 600,
    title: 'Craft Overlay — PoE2',
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(join(__dirname, 'renderer/index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createOverlayWindow(): void {
  overlayWindow = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_MAX_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: false,
    type: 'toolbar',
    roundedCorners: false,
    autoHideMenuBar: true,
    title: 'Craft Overlay',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setMenuBarVisibility(false);
  overlayWindow.loadFile(join(__dirname, 'renderer/overlay.html'));

  overlayReady = new Promise((resolve) => {
    overlayWindow?.webContents.once('did-finish-load', () => resolve());
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
    overlayReady = null;
  });
}

async function ensureOverlayWindow(): Promise<BrowserWindow> {
  if (!overlayWindow) createOverlayWindow();
  if (!overlayWindow) throw new Error('Не удалось создать окно оверлея');
  await overlayReady;
  return overlayWindow;
}

function positionOverlay(window: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { workArea } = display;

  const height = Math.min(OVERLAY_MAX_HEIGHT, workArea.height - 24);

  let x = cursor.x + 24;
  if (x + OVERLAY_WIDTH > workArea.x + workArea.width) {
    x = cursor.x - OVERLAY_WIDTH - 24;
  }
  x = Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - OVERLAY_WIDTH - 8));

  let y = cursor.y - 48;
  if (y + height > workArea.y + workArea.height) {
    y = workArea.y + workArea.height - height - 8;
  }
  y = Math.max(workArea.y + 8, y);

  window.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: OVERLAY_WIDTH,
    height: Math.round(height),
  });
}

function looksLikeItem(text: string): boolean {
  return text.includes('--------') && /(Класс предмета|Item Class):/.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function sendAdvancedCopy(): Promise<void> {
  if (process.platform !== 'win32') return;

  // -EncodedCommand избавляет от проблем с кавычками в C#-коде при передаче
  // аргументов через Windows.
  const encoded = Buffer.from(SEND_ADVANCED_COPY_SCRIPT, 'utf16le').toString('base64');
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    { windowsHide: true, timeout: 5000 },
  );
}

async function waitForCopiedItem(previous: string): Promise<string | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 2500) {
    const current = await clipboard.readText();
    if (looksLikeItem(current) && current !== previous) {
      return current;
    }
    await sleep(50);
  }

  const current = await clipboard.readText();
  return looksLikeItem(current) && current !== previous ? current : null;
}

async function showOverlay(channel: string, payload: unknown): Promise<void> {
  const window = await ensureOverlayWindow();
  lastOverlay = { channel, payload };
  positionOverlay(window);
  window.webContents.send(channel, payload);

  if (window.isVisible()) {
    window.moveTop();
  } else {
    window.showInactive();
  }

  window.setAlwaysOnTop(true, 'screen-saver');
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

function updateSettings(next: Settings): void {
  settings = next;
  saveSettings(settingsPath(), settings);
}

function settingsView(): unknown {
  return {
    tolerancePct: settings.tolerancePct,
    league: settings.league,
    pricesFetchedAt: settings.prices?.fetchedAt ?? null,
    priceRows: priceRows(settings),
    targets: settings.targets.flatMap((saved) => summarizeTarget(saved.id, saved.text, saved.basePrice) ?? []),
  };
}

/** Ошибка сети не мешает проверке: считаем по старым и ручным ценам. */
async function refreshPrices(): Promise<string | undefined> {
  try {
    updateSettings({ ...settings, prices: await fetchPrices(settings.league) });
    return undefined;
  } catch (error) {
    console.error('Не удалось обновить цены:', error);
    return 'Цены с poe.ninja не обновились: использованы сохранённые и ручные.';
  }
}

function runInWorker<T>(message: object, fallback: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'target-worker.cjs'));
    worker.once('message', (result: T) => {
      resolve(result);
      void worker.terminate();
    });
    worker.once('error', reject);
    worker.postMessage({ ...message, settings });
  }).catch((error: unknown) => {
    console.error('Поток расчёта не запустился, считаем в основном:', error);
    return fallback();
  });
}

async function showTargetCheck(text: string | null): Promise<void> {
  if (text === null) {
    await showOverlay('capture:result', null);
    return;
  }
  // Ждём сеть только без единой цены: устаревшие курсы обновятся к следующей проверке.
  let pricesNote: string | undefined;
  if (settings.prices?.league !== settings.league) pricesNote = await refreshPrices();
  else if (pricesAreStale(settings)) void refreshPrices();
  await showOverlay('target:result', { reports: [], divinePrice: null, pending: true });
  const check = await runInWorker({ text }, () => checkItem(text, settings));
  await showOverlay('target:result', { ...check, ...(pricesNote ? { pricesNote } : {}) });
}

async function captureItemFromGame(showResult: (text: string | null) => Promise<void>): Promise<void> {
  if (captureInProgress) return;
  captureInProgress = true;
  console.log('[hotkey] pressed');
  let clearedItem: string | null = null;

  try {
    // Важно: окно приложения НЕ показываем и НЕ фокусируем до отправки клавиш,
    // иначе Ctrl+Alt+C уйдёт в наше окно, а не в игру.
    const previous = await clipboard.readText();
    // Повторное копирование того же предмета даёт тот же текст: старый предмет
    // убираем, чтобы заметить новое копирование. Чужой текст в буфере не трогаем.
    if (looksLikeItem(previous)) {
      clearedItem = previous;
      clipboard.clear();
    }
    await sendAdvancedCopy();
    console.log('[capture] Ctrl+Alt+C sent');
    const text = await waitForCopiedItem(clearedItem === null ? previous : '');
    console.log(`[capture] clipboard: ${text ? `${text.length} chars` : 'no item'}`);

    mainWindow?.webContents.send('capture:result', text);
    await showResult(text);
  } catch (error) {
    console.error('Не удалось скопировать предмет из игры:', error);
    mainWindow?.webContents.send('capture:result', null);
    await showOverlay('capture:result', null);
  } finally {
    if (clearedItem !== null && !clipboard.readText()) clipboard.writeText(clearedItem);
    captureInProgress = false;
  }
}

app.whenReady().then(() => {
  settings = loadSettings(settingsPath());

  ipcMain.handle('settings:get', () => settingsView());
  ipcMain.handle('settings:update', (_event, patch: unknown) => {
    updateSettings(sanitizeSettings({ ...settings, ...(patch as object) }));
    return settingsView();
  });
  ipcMain.handle('target:add', (_event, text: unknown) => {
    if (typeof text !== 'string') return { error: 'Пустой текст.' };
    const target = readTarget(text);
    if ('error' in target) return target;
    updateSettings(
      sanitizeSettings({ ...settings, targets: [...settings.targets, { id: randomUUID(), text }] }),
    );
    return settingsView();
  });
  ipcMain.handle('target:remove', (_event, id: unknown) => {
    updateSettings({ ...settings, targets: settings.targets.filter((saved) => saved.id !== id) });
    return settingsView();
  });
  ipcMain.handle('target:base-price', (_event, id: unknown, basePrice: unknown) => {
    const targets = settings.targets.map((saved) => {
      if (saved.id !== id) return saved;
      const { basePrice: _old, ...rest } = saved;
      return { ...rest, basePrice };
    });
    updateSettings(sanitizeSettings({ ...settings, targets }));
    return settingsView();
  });
  ipcMain.handle('target:bases', (_event, id: unknown) => {
    if (typeof id !== 'string') return null;
    return runInWorker({ baseId: id }, () => baseAdvice(id, settings));
  });
  ipcMain.handle('plan:get', () => settings.activePlan);
  ipcMain.handle('plan:save', (_event, plan: unknown) => {
    updateSettings(sanitizeSettings({ ...settings, activePlan: plan }));
  });
  ipcMain.handle('prices:refresh', async () => ({
    error: await refreshPrices(),
    view: settingsView(),
  }));

  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('clipboard:write', (_event, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text);
  });
  ipcMain.on('overlay:hide', () => {
    const wasVisible = overlayWindow?.isVisible();
    overlayWindow?.hide();
    console.log(`[overlay] hide via titlebar: ${wasVisible} -> ${overlayWindow?.isVisible()}`);
  });
  ipcMain.on('overlay:quit', () => {
    console.log('[overlay] quit via titlebar');
    app.quit();
  });
  ipcMain.on('overlay:move', (_event, dx: unknown, dy: unknown) => {
    if (!overlayWindow || typeof dx !== 'number' || typeof dy !== 'number') return;
    const [x = 0, y = 0] = overlayWindow.getPosition();
    overlayWindow.setPosition(Math.round(x + dx), Math.round(y + dy));
  });

  createMainWindow();
  createOverlayWindow();

  const captureRegistered = globalShortcut.register(CAPTURE_HOTKEY, () => {
    void captureItemFromGame((text) => showOverlay('capture:result', text));
  });
  if (!captureRegistered) {
    console.warn(`Не удалось зарегистрировать глобальный хоткей ${CAPTURE_HOTKEY}`);
  } else {
    console.log(`[hotkey] registered ${CAPTURE_HOTKEY}`);
  }

  const targetRegistered = globalShortcut.register(TARGET_HOTKEY, () => {
    void captureItemFromGame(showTargetCheck);
  });
  if (!targetRegistered) {
    console.warn(`Не удалось зарегистрировать глобальный хоткей ${TARGET_HOTKEY}`);
  }

  const hideRegistered = globalShortcut.register(HIDE_OVERLAY_HOTKEY, () => {
    console.log('[hotkey] hide pressed');
    if (overlayWindow?.isVisible()) {
      overlayWindow.hide();
      console.log('[overlay] hidden');
      return;
    }
    // Содержимое не пересылаем: в окне мог быть открыт план с отметками.
    if (lastOverlay && overlayWindow) {
      positionOverlay(overlayWindow);
      overlayWindow.showInactive();
      overlayWindow.setAlwaysOnTop(true, 'screen-saver');
      console.log('[overlay] shown again');
    }
  });
  if (!hideRegistered) {
    console.warn(`Не удалось зарегистрировать глобальный хоткей ${HIDE_OVERLAY_HOTKEY}`);
  } else {
    console.log(`[hotkey] registered ${HIDE_OVERLAY_HOTKEY}`);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
