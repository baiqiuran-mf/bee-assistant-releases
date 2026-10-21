/**
 * 预加载脚本：只向渲染进程暴露极小的“桌面端”能力。
 * 不暴露任何 Node / 文件系统能力，保持 contextIsolation 安全。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('beeDesktop', {
  isDesktop: true,
  platform: process.platform,
});

/**
 * 主窗口「是否最大化」状态通道（2026-10-09 加）：
 *   onState(cb) —— 主进程在 maximize / unmaximize / 首屏加载完成后推当前状态，
 *                  cb('maximized' | 'normal')。渲染进程据此给 body 加/去 .win-max，
 *                  从而把右栏宽度在 450px（平时）/ 500px（最大化）之间切换。
 */
contextBridge.exposeInMainWorld('beeWindow', {
  onState: (cb) => ipcRenderer.on('win:state', (_e, d) => cb(d)),
});

/**
 * 关闭软件时的「数据保存中」浮层通道（2026-10-15 加，共享翻译记忆）：
 *   主进程在 before-quit 跑同步，通过 IPC 推进度；渲染进程据此显示浮层。
 *   onStart / onProgress / onEnd 分别接 tm:sync-start / tm:sync-progress / tm:sync-end。
 */
contextBridge.exposeInMainWorld('beeTmSync', {
  onStart: (cb) => ipcRenderer.on('tm:sync-start', (_e, d) => cb(d)),
  onProgress: (cb) => ipcRenderer.on('tm:sync-progress', (_e, d) => cb(d)),
  onEnd: (cb) => ipcRenderer.on('tm:sync-end', (_e, d) => cb(d)),
});

/**
 * 关闭确认框通道（2026-10-15 v2.6.1133 加）：
 *   主进程点 X 时通过 IPC 让渲染进程弹「确定关闭？」浮层；
 *   onShow(cb)    —— 主进程发 'close:confirm-show' 时渲染进程显示浮层
 *   confirm()     —— 用户点「确定关闭」→ 主进程进入「备份+进度条→退出」序列
 *   cancel()      —— 用户点「取消」→ 留在软件
 */
contextBridge.exposeInMainWorld('beeCloseConfirm', {
  onShow: (cb) => ipcRenderer.on('close:confirm-show', (_e) => cb()),
  confirm: () => ipcRenderer.invoke('close:confirm-result', true),
  cancel: () => ipcRenderer.invoke('close:confirm-result', false),
});

/**
 * 「每日话术编排台」独立浮窗通道：
 *   open(code)  —— 打开（或聚焦）浮窗并加载该客户；浮窗是真正的系统窗口，可拖到主窗口外任意位置
 *   sync(code)  —— 浮窗已开着就跟着切客户；没开就不动（不主动弹窗）
 *   close()     —— 关掉浮窗
 */
contextBridge.exposeInMainWorld('beeBoard', {
  open: (code) => ipcRenderer.invoke('board:open', code),
  sync: (code) => ipcRenderer.invoke('board:sync', code),
  close: () => ipcRenderer.invoke('board:close'),
});

/**
 * 「全局设置」独立窗口通道（2026-09-30 加）：
 *   open() —— 打开（或聚焦）那扇窗，标题「全局设置」，里面装着
 *             AI 设置 / AI 提示词 / 模拟新消息（原来挤在顶栏的三个按钮）。
 *   这扇窗自己用 window.close() 关，不需要额外通道。
 */
contextBridge.exposeInMainWorld('beeSettings', {
  // open(tab) —— tab 可选，传了就打开后直接落到那个页签（v1.0.1：'cloud'）
  open: (tab) => ipcRenderer.invoke('settings:open', tab || ''),
});

/**
 * 「针对这条消息的建议」独立浮窗通道（仿 board）：
 *   open(sug)   —— 打开（或聚焦）建议浮窗，并把这份建议数据塞进去渲染（老板 2026-10-18：弹窗先用 pending 骨架，AI 回来再 push）
 *   push(sug)   —— 窗口已存在时，把新数据推过去替换内容（不重载页面）
 *   close()     —— 关掉建议浮窗
 *   onData(cb)  —— 主进程把建议数据推过来时触发（cb(sug)）
 *   resize(w,h) —— 改窗口尺寸（加翻译栏 / 关翻译栏时用）
 *   toggleMax() —— 最大化 / 还原
 * 浮窗是真正的系统窗口，可拖到主窗口外任意位置。
 */
contextBridge.exposeInMainWorld('beeSuggest', {
  open: (sug) => ipcRenderer.invoke('suggest:open', sug),
  push: (sug) => ipcRenderer.invoke('suggest:push', sug),
  close: () => ipcRenderer.invoke('suggest:close'),
  onData: (cb) => ipcRenderer.on('suggest:data', (_e, d) => cb(d)),
  resize: (w, h) => ipcRenderer.invoke('suggest:resize', w, h),
  toggleMax: () => ipcRenderer.invoke('suggest:toggle-max'),
});

/**
 * 「📞 抓取电话」独立窗口通道（2026-10-07 加）：
 *   open(code, name) —— 打开（或聚焦）抓取窗，扫这个客户的历史对话
 *   close()          —— 关掉抓取窗
 *   onData(cb)       —— 主进程把客户名推过来时触发（cb({code, name})）
 * 这个窗口是**只读**的：页面只会发 GET /api/phone/scan，不会写任何数据。
 */
contextBridge.exposeInMainWorld('beePhone', {
  open: (code, name) => ipcRenderer.invoke('phone:open', code, name || ''),
  close: () => ipcRenderer.invoke('phone:close'),
  onData: (cb) => ipcRenderer.on('phone:data', (_e, d) => cb(d)),
});

/**
 * 「翻译」独立浮窗通道：
 *   open(payload) —— 打开（或聚焦）翻译浮窗，payload = { text, code, count }
 *   close()      —— 关掉翻译浮窗
 *   onData(cb)   —— 主进程把翻译请求推过来时触发（cb(payload)）
 * 同样是可拖到主窗口外的系统窗口；采纳 / 翻译都会把它顶到最前。
 */
contextBridge.exposeInMainWorld('beeTranslate', {
  open: (payload) => ipcRenderer.invoke('translate:open', payload),
  close: () => ipcRenderer.invoke('translate:close'),
  onData: (cb) => ipcRenderer.on('translate:data', (_e, d) => cb(d)),
});

/**
 * 「截图 + 截图翻译」通道：
 *   captureScreen()  —— 在渲染进程里用 desktopCapturer 抓整屏（主进程拿不到这个能力），
 *                       返回 { dataUrl, width, height, dpr, screenX, screenY }。
 *   confirm(payload) —— 选区确认：把整屏 dataURL + 选区（图内像素坐标）交给主进程裁剪。
 *   cancel()         —— 取消截图，关掉遮罩。
 *   translate(p)     —— 900x30 工具条「翻译」按钮：主进程裁好图后由它触发 AI 视觉翻译。
 *   save(p)          —— 工具条「保存图片」按钮：主进程按设置路径落盘。
 *   setHotkey(...)   —— 设置页改了快捷键，通知主进程重注册全局快捷键。
 *   onPopupData(cb)  —— 主进程把裁剪后的图推给 900x30 工具条。
 *   onResultData(cb) —— 主进程把「译文 + 截图」推给独立翻译窗口。
 *   其余 close* 用于各窗口自行关闭。
 */
contextBridge.exposeInMainWorld('beeShot', {
  captureScreen: () => {
    // ⚠️ 注意：screen 是【主进程专有】模块，在 preload(渲染进程) 里 require('electron').screen
    // 是 undefined，调用会抛「Cannot read properties of undefined (reading 'getDisplayNearestPoint')」。
    // 所以：屏幕图像用渲染进程的 desktopCapturer 抓（preload 可用），屏幕几何信息(坐标/dpr)走主进程 IPC。
    const { desktopCapturer } = require('electron');
    return (async () => {
      const geo = await ipcRenderer.invoke('shot:display-geometry');
      const tW = Math.round(geo.width * geo.dpr);
      const tH = Math.round(geo.height * geo.dpr);
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: tW, height: tH },
      });
      const src = sources.find((s) => String(s.display_id) === String(geo.displayId))
        || sources.find((s) => String(s.id).startsWith('screen'))
        || sources[0];
      if (!src) return null;
      return {
        dataUrl: src.thumbnail.toDataURL(),
        width: tW,
        height: tH,
        dpr: geo.dpr,
        screenX: geo.screenX,
        screenY: geo.screenY,
      };
    })();
  },
  confirm: (payload) => ipcRenderer.invoke('shot:confirm', payload),
  cancel: () => ipcRenderer.invoke('shot:cancel'),
  // 渲染进程抓完图后通知主进程「可以显示遮罩了」（截图在隐藏时抓，避免拍到自己）
  ready: () => ipcRenderer.invoke('shot:ready'),
  // 主进程兜底抓屏（preload 的 desktopCapturer 取不到时用）
  captureMain: () => ipcRenderer.invoke('shot:capture-main'),
  translate: (payload) => ipcRenderer.invoke('shot:translate', payload),
  save: (payload) => ipcRenderer.invoke('shot:save', payload),
  setHotkey: (enabled, hotkey) => ipcRenderer.invoke('shot:set-hotkey', { enabled, hotkey }),
  onPopupData: (cb) => ipcRenderer.on('shot:popup-data', (_e, d) => cb(d)),
  onResultData: (cb) => ipcRenderer.on('shot:result-data', (_e, d) => cb(d)),
  closePopup: () => ipcRenderer.invoke('shot:close-popup'),
  closeResult: () => ipcRenderer.invoke('shot:close-result'),
});

