/**
 * preload —— 渲染进程唯一能用的桥。
 *
 * 只暴露四个方法 ✓（`contextIsolation: true` + `sandbox: true` 下，
 * 渲染进程碰不到 Node、也碰不到文件系统 ✓）。要加能力**必须**在这儿显式加 ✓，
 * 别把 `ipcRenderer` 整个丢过去 ✗。
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('anko', {
    /** 读设置 ✓ */
    getSettings: () => ipcRenderer.invoke('anko:getSettings'),

    /** 存设置 ✓ */
    saveSettings: (settings) => ipcRenderer.invoke('anko:saveSettings', settings),

    /** 可选的 API 形态（'openai' / 'gemini'）✓ */
    apiKinds: () => ipcRenderer.invoke('anko:apiKinds'),

    /** 跑一幕：返回 { ok, outline, rolls, warnings } ✓ */
    run: (payload) => ipcRenderer.invoke('anko:run', payload),

    /**
     * 进度回调 ✓。返回一个取消订阅函数（避免热重载时越挂越多 ✓）。
     */
    onProgress: (callback) => {
        if (typeof callback !== 'function') {
            return () => {};
        }
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('anko:progress', handler);
        return () => ipcRenderer.removeListener('anko:progress', handler);
    },
});
