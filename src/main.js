const { app, BrowserWindow, ipcMain, shell, globalShortcut } = require('electron');
const path = require('path');
const querystring = require('querystring');
const axios = require('axios');
const secure = require('./config/secure');


const client_id = secure.clientId;
const client_secret = secure.clientSecret;
const redirect_uri = secure.redirectUri;

if (!client_id || !client_secret || !redirect_uri) {
  console.error('Missing critical environment variables. Exiting.');
  app.quit();
}

let mainWindow = null;
let storedPlaylists = [];
let accessToken = null;
let authWindow = null;
let isProcessingAuth = false;

function createWindow() {
  if (mainWindow) {
    if (!mainWindow.isDestroyed()) {
      return mainWindow;
    }
  }

  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      enableRemoteModule: false,
      nodeIntegration: false 
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
  
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

async function handleLogin() {
  accessToken = null;
  
  if (authWindow) {
    authWindow.close();
    authWindow = null;
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
  }

  await mainWindow.webContents.session.clearStorageData({
    storages: ['cookies', 'localstorage', 'caches', 'serviceworkers']
  });

  const authUrl = 'https://accounts.spotify.com/authorize?' +
    querystring.stringify({
      response_type: 'code',
      client_id: client_id,
      scope: 'user-read-private user-read-email user-library-read user-read-playback-state playlist-modify-public',
      redirect_uri: redirect_uri,
      show_dialog: true,
      state: Math.random().toString(36).substring(7)
    });

  authWindow = new BrowserWindow({
    width: 800,
    height: 600,
    parent: mainWindow,
    modal: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  authWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.log('Failed to load:', validatedURL);
    if (validatedURL.startsWith(redirect_uri)) {
      handleCallback(validatedURL);
    }
  });

  authWindow.webContents.on('will-navigate', (event, url) => {
    console.log('Navigating to:', url);
    if (url.startsWith(redirect_uri)) {
      handleCallback(url);
    }
  });

  authWindow.webContents.on('will-redirect', (event, url) => {
    console.log('Redirecting to:', url);
    if (url.startsWith(redirect_uri)) {
      handleCallback(url);
    }
  });

  try {
    await authWindow.loadURL(authUrl);
  } catch (error) {
    console.error('Failed to load auth URL:', error);
    sendLog('Authentication failed: Could not load login page');
    if (authWindow) {
      authWindow.close();
      authWindow = null;
    }
  }

  authWindow.on('closed', () => {
    authWindow = null;
    if (!accessToken) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload();
      }
    }
  });
}

async function handleCallback(url) {
  if (isProcessingAuth) {
    return;
  }

  if (!url) {
    console.error('No URL provided to callback handler');
    return;
  }

  try {
    isProcessingAuth = true;
    const urlObj = new URL(url);
    const code = urlObj.searchParams.get('code');
    const error = urlObj.searchParams.get('error');
    
    if (error) {
      console.error('Authentication error:', error);
      sendLog('Authentication failed: ' + error);
      if (authWindow) {
        authWindow.close();
        authWindow = null;
      }
      return;
    }

    if (!code) {
      throw new Error('No code received from Spotify');
    }

    console.log('Exchanging auth code for access token...');
    const response = await getSpotifyToken(code);
    
    if (!response.data || !response.data.access_token) {
      throw new Error('No access token in response');
    }

    accessToken = response.data.access_token;
    console.log('Successfully obtained access token');

    if (authWindow) {
      authWindow.close();
      authWindow = null;
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createWindow();
    }

    mainWindow.webContents.send('access_token', accessToken);
    const playlists = await fetchPlaylists(accessToken);
    if (playlists) {
      mainWindow.webContents.send('playlists', playlists);
    } else {
      throw new Error('Failed to fetch playlists');
    }
  } catch (error) {
    console.error('Failed to complete authentication:', error);
    sendLog('Failed to login: ' + (error.message || 'Unknown error'));
    accessToken = null;
    if (authWindow) {
      authWindow.close();
      authWindow = null;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
  } finally {
    isProcessingAuth = false;
  }
}

function sendLog(message) {
  if (mainWindow) {
    mainWindow.webContents.send('log-message', message);
  }
}

async function fetchPlaylists(token) {
  try {
    const response = await axios.get('https://api.spotify.com/v1/me/playlists', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching playlists:', error);
    return null;
  }
}

async function getCurrentSong(token) {
  try {
    const response = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (response.status === 204 || response.data === '') {
      sendLog('No song is currently playing');
      return null;
    }

    const songInfo = response.data;

    if (!songInfo.item || !songInfo.item.uri) {
      sendLog('No track URI found in the response');
      return null;
    }

    return {
      trackUri: songInfo.item.uri,
      trackName: songInfo.item.name,
      artistName: songInfo.item.artists.map(artist => artist.name).join(', '),
      albumName: songInfo.item.album.name,
      albumArt: songInfo.item.album.images[0].url,
      isPlaying: songInfo.is_playing
    };
  } catch (error) {
    sendLog('Failed to get current song:', error);
    return null;
  }
}

async function addSongToPlaylist(token, playlistId, trackUri) {
  try {
    const response = await axios.post(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
      uris: [trackUri]
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    return response.status === 201;  // Return true if the track was added successfully
  } catch (error) {
    sendLog(`Failed to add track to playlist ${playlistId}:`, error);
    return false;
  }
}

ipcMain.on('set-playlists', (event, playlists) => {
  storedPlaylists = playlists;
});

function getPlaylistNameById(playlistId) {
  const playlist = storedPlaylists.items.find(p => p.id === playlistId);
  return playlist ? playlist.name : 'Unknown Playlist';
}

ipcMain.handle('get-playlists', () => {
  return storedPlaylists;
});

ipcMain.on('save-hotkeys', async (event, hotkeysData) => {
  globalShortcut.unregisterAll();

  hotkeysData.forEach(([key, playlistId]) => {
    const playlistName = getPlaylistNameById(playlistId);
    if (!key) {
      sendLog(`Warning: ${playlistName} Hotkey not registered because no key was provided.`);
      return;
    }
    globalShortcut.register(key, async () => {
      const currentSong = await getCurrentSong(accessToken);
      if (currentSong && currentSong.trackUri) {
        const success = await addSongToPlaylist(accessToken, playlistId, currentSong.trackUri);
        if (success) {
          sendLog(`Added "${currentSong.trackName}" by ${currentSong.artistName} to "${playlistName}"`);
        } else {
          sendLog(`Failed to add current song to playlist "${playlistName}"`);
        }
      }
    });
  });

});

ipcMain.on('disable-hotkeys', () => {
  globalShortcut.unregisterAll();
  sendLog('Hotkeys have been disabled');
});

ipcMain.on('spotify-login', handleLogin);

app.on('ready', () => {
  mainWindow = createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.on('logout', (event, removeAccount = false) => {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.session.clearStorageData({
      storages: ['cookies', 'localstorage', 'caches', 'serviceworkers']
    });
  }
  
  accessToken = null;
  storedPlaylists = [];
  globalShortcut.unregisterAll();
  
  if (mainWindow) {
    mainWindow.reload();
  }
});

async function getSpotifyToken(code) {
  console.log('Getting Spotify token...');
  const tokenUrl = 'https://accounts.spotify.com/api/token';
  const authHeader = Buffer.from(`${client_id}:${client_secret}`).toString('base64');

  try {
    const response = await axios.post(tokenUrl, 
      querystring.stringify({
        code: code,
        redi
