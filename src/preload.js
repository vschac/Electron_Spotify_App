const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  spotifyLogin: () => ipcRenderer.send('spotify-login'),
  onAccessToken: (callback) => ipcRenderer.on('access_token', (event, token) => callback(token)),
  onPlaylists: (callback) => ipcRenderer.on('playlists', (event, playlists) => callback(playlists)),
  setPlaylists: (playlists) => ipcRenderer.send('set-playlists', playlists),
  getPlaylists: () => ipcRenderer.invoke('get-playlists'),
  saveHotkeys: (hotkeysData) => ipcRenderer.send('save-hotkeys', hotkeysData),
  onLogMessage: (callback) => ipcRenderer.on('log-message', callback),
  disableHotkeys: () => ipcRenderer.send('disable-hotkeys'),
});
