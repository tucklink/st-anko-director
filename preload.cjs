/**
 * preload（CommonJS 版）—— 因为主进程是 .cjs、且 Electron v20 的 preload 也走 CJS ✓。
 *
 * 只暴露四个方法 ✓（`contextIsolation: true` + `sandbox: true` 下渲染进程碰不到 Node ✓）。
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('anko', {
    getSettings: () => ipcRenderer.invoke('anko:getSettings'),
    saveSettings: (settings) => ipcRenderer.invoke('anko:saveSettings', settings),
    apiKinds: () => ipcRenderer.invoke('anko:apiKinds'),
    run: (payload) => ipcRenderer.invoke('anko:run', payload),
    onProgress: (callback) => {
        if (typeof callback !== 'function') {
            return () => {};
        }
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('anko:progress', handler);
        return () => ipcRenderer.removeListener('anko:progress', handler);
    },
});
