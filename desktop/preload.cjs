const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, data) => fn(data));

contextBridge.exposeInMainWorld('desk', {
  /* 鱼缸主窗口 */
  setHit: (inside) => ipcRenderer.send('desk:hit', inside),
  openMenu: () => ipcRenderer.send('desk:menu'),
  dragStart: (point) => ipcRenderer.send('desk:drag-start', point),
  dragMove: (point) => ipcRenderer.send('desk:drag-move', point),
  dragEnd: () => ipcRenderer.send('desk:drag-end'),
  reportTankRect: (rect) => ipcRenderer.send('desk:tank-rect', rect),
  toggleFill: () => ipcRenderer.send('desk:toggle-fill'),
  onScreensaver: on('desk:screensaver'),
  startScreensaver: (mode) => ipcRenderer.invoke('desk:start-screensaver', mode),
  exitScreensaver: (opts) => ipcRenderer.send('desk:exit-screensaver', opts),
  verifyUnlock: () => ipcRenderer.invoke('desk:verify-unlock'),
  lockWindows: () => ipcRenderer.send('desk:lock-windows'),
  onRoam: on('desk:roam'),
  exitRoam: () => ipcRenderer.send('desk:roam-exit'),
  setAutoScreensaver: (on) => ipcRenderer.invoke('desk:set-auto-screensaver', on),
  setScreensaverConfig: (patch) => ipcRenderer.invoke('desk:set-screensaver-config', patch),
  setGrowthConfig: (patch) => ipcRenderer.invoke('desk:set-growth-config', patch),
  recordFeed: () => ipcRenderer.send('desk:record-feed'),
  zoomBy: (factor) => ipcRenderer.send('desk:zoom-by', factor),
  onboardDone: () => ipcRenderer.send('desk:onboard-done'),
  getConfig: () => ipcRenderer.invoke('desk:get-config'),
  onConfig: on('desk:config'),
  onAction: on('desk:action'),
  reportState: (patch) => ipcRenderer.send('desk:state', patch),
  sendReply: (friendId, text) => ipcRenderer.send('desk:reply', { friendId, text }),
  sendInteract: (friendId, kind) => ipcRenderer.send('desk:interact', { friendId, kind }),
  peekFriend: (friend) => ipcRenderer.send('desk:peek-friend', friend),
  onFriendEvent: on('desk:friend'),

  /* 小窗通用 */
  closeDialog: () => ipcRenderer.send('desk:close-dialog'),
  quitApp: () => ipcRenderer.send('desk:quit-app'),
  openSite: () => ipcRenderer.send('desk:open-site'),

  /* 配对 / 反馈 */
  getPairInfo: (ip) => ipcRenderer.invoke('desk:pair-info', ip),
  onPhoneCount: on('desk:phone-count'),
  submitFeedback: (payload) => ipcRenderer.invoke('desk:submit-feedback', payload),

  /* 商城与账号 */
  getStore: () => ipcRenderer.invoke('desk:store'),
  onStoreData: on('desk:store-data'),
  onStorePaid: on('desk:store-paid'),
  onStoreTab: on('desk:store-tab'),
  openUpgrade: (skuId) => ipcRenderer.send('desk:open-upgrade', skuId || null),
  getUpgradeTarget: () => ipcRenderer.invoke('desk:upgrade-target'),
  onUpgradeTarget: on('desk:upgrade-target'),
  setUpgradeWidth: (width) => ipcRenderer.send('desk:set-upgrade-width', Number(width)),
  openConsole: (tab) => ipcRenderer.send('desk:open-console', tab || 'look'),
  onConsoleTab: on('desk:console-tab'),
  openPayUrl: (url) => ipcRenderer.invoke('desk:open-pay-url', url),
  applyTheme: (themeId) => ipcRenderer.invoke('desk:store-apply', themeId),
  previewTheme: (themeId) => ipcRenderer.invoke('desk:store-preview', themeId),
  applySkin: (skinId) => ipcRenderer.invoke('desk:store-apply-skin', skinId),
  previewSkin: (skinId) => ipcRenderer.invoke('desk:store-preview-skin', skinId),
  buy: (skuId, opts) => ipcRenderer.invoke('desk:store-buy', skuId, opts),
  redeem: (code) => ipcRenderer.invoke('desk:store-redeem', code),
  updateProfile: (patch) => ipcRenderer.invoke('desk:store-profile', patch),
  setCloud: (on) => ipcRenderer.invoke('desk:store-cloud', on),
  deleteCloudData: () => ipcRenderer.invoke('desk:store-delete'),
  exportRecovery: () => ipcRenderer.invoke('desk:export-recovery'),
  importRecovery: (code) => ipcRenderer.invoke('desk:import-recovery', code),
  friendAction: (action, friendId, accept) => ipcRenderer.invoke('desk:friend-action', action, friendId, accept),

  /* 鱼缸内提醒 / 欢迎起名 / 二级菜单 */
  getNoticeInfo: () => ipcRenderer.invoke('desk:notice-info'),
  onNoticeData: on('desk:notice-data'),
  onNotice: on('desk:notice'),
  onRequests: on('desk:requests'),
  onUpsell: on('desk:upsell'),
  checkNickname: (nickname) => ipcRenderer.invoke('desk:check-nickname', nickname),
  claimNickname: (nickname, breed) => ipcRenderer.invoke('desk:claim-nickname', nickname, breed),
  getMenuState: () => ipcRenderer.invoke('desk:menu-state'),
  onMenuState: on('desk:menu-state'),
  menuExec: (cmd, value) => ipcRenderer.send('desk:menu-exec', cmd, value),
  setMenuSub: (open) => ipcRenderer.send('desk:menu-sub', Boolean(open)),
  setMenuWidth: (width) => ipcRenderer.send('desk:menu-width', Number(width)),

  /* 升级 */
  getUpdateInfo: () => ipcRenderer.invoke('desk:update-info'),
  onUpdateAvailable: on('desk:update-available'),
  onUpdateData: on('desk:update-data'),
  onUpdateProgress: on('desk:update-progress'),
  startUpdate: (opts) => ipcRenderer.invoke('desk:start-update', opts),
  cancelUpdate: () => ipcRenderer.send('desk:cancel-update'),
  skipUpdate: () => ipcRenderer.send('desk:skip-update')
});
