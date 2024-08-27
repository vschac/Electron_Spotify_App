const { app, BrowserWindow, ipcMain, shell, globalShortcut } = require('electron');
const path = require('path');
const querystring = require('querystring');
const axios = require('axios');
require('dotenv').config();

const client_id = process.env.SPOTIFY_CLIENT_ID;
const client_secret = process.env.SPOTIFY_CLIENT_SECRET;
const redirect_uri = process.env.SPOTIFY_REDIRECT_URI;

if (!client_id || !client_secret || !redirect_uri) {
  console.error('Missing critical environment variables. Exiting.');
  app.quit();
}


let mainWindow;
let storedPlaylists = [];
let accessToken; 


function createWindow() {
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
}


async function handleLogin() {
  const authUrl = 'https://accounts.spotify.com/authorize?' +
    querystring.stringify({
      response_type: 'code',
      client_id: client_id,
      scope: 'user-read-private user-read-email user-library-read user-read-playback-state playlist-modify-public',
      redirect_uri: redirect_uri
    });

  let authWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  authWindow.loadURL(authUrl);

  authWindow.webContents.on('will-redirect', async (event, url) => {
    if (url.startsWith(redirect_uri)) {
      const code = new URL(url).searchParams.get('code');
      authWindow.close();
      const authOptions = {
        url: 'https://accounts.spotify.com/api/token',
        form: {
          code: code,
          redirect_uri: redirect_uri,
          grant_type: 'authorization_code'
        },
        headers: {
          'Authorization': 'Basic ' + (Buffer.from(client_id + ':' + client_secret).toString('base64'))
        },
        json: true
      };

      try {
        const response = await axios.post(authOptions.url, querystring.stringify(authOptions.form), { headers: authOptions.headers });
        accessToken = response.data.access_token;  // Store access token in global variable

        // Send access token to renderer process
        mainWindow.webContents.send('access_token', accessToken);

        // Fetch and send playlists to renderer process
        const playlists = await fetchPlaylists(accessToken);
        mainWindow.webContents.send('playlists', playlists);
      } catch (error) {
        console.log('Failed to get access token:', error);
      }
    }
  });

  authWindow.on('closed', () => {
    authWindow = null;
  });
}

function sendLog(message) {
  if (mainWindow) {
    mainWindow.webContents.send('log-message', message);
  }
}

async function fetchPlaylists(token) {
  const response = await axios.get('https://api.spotify.com/v1/me/playlists', {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  return response.data;
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

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
