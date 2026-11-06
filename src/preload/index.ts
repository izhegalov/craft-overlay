import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('craft', {
  readClipboard: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
  hideOverlay: (): void => ipcRenderer.send('overlay:hide'),
  quitApp: (): void => ipcRenderer.send('overlay:quit'),
  moveOverlay: (dx: number, dy: number): void => ipcRenderer.send('overlay:move', dx, dy),
  getSettings: (): Promise<unknown> => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: unknown): Promise<unknown> => ipcRenderer.invoke('settings:update', patch),
  addTarget: (text: string): Promise<unknown> => ipcRenderer.invoke('target:add', text),
  removeTarget: (id: string): Promise<unknown> => ipcRenderer.invoke('target:remove', id),
  setBasePrice: (id: string, price: number | null): Promise<unknown> =>
    ipcRenderer.invoke('target:base-price', id, price),
  getBases: (id: string): Promise<unknown> => ipcRenderer.invoke('target:bases', id),
  refreshPrices: (): Promise<unknown> => ipcRenderer.invoke('prices:refresh'),
  getPlan: (): Promise<unknown> => ipcRenderer.invoke('plan:get'),
  savePlan: (plan: unknown): Promise<void> => ipcRenderer.invoke('plan:save', plan),
  onTargetResult: (callback: (check: unknown) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, check: unknown): void => callback(check);
    ipcRenderer.on('target:result', listener);
    return () => {
      ipcRenderer.removeListener('target:result', listener);
    };
  },
  onCapture: (callback: (text: string | null) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, text: string | null): void => callback(text);
    ipcRenderer.on('capture:result', listener);
    return () => {
      ipcRenderer.removeListener('capture:result', listener);
    };
  },
});
