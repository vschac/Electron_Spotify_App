# Spotify Playlist Hotkey

A desktop application that allows you to add currently playing Spotify songs to playlists using hotkeys.

## Installation on macOS

1. Download the .dmg file
2. Drag the app to your Applications folder
3. The first time you open the app:
   - Right-click (or Control-click) the app in Finder
   - Select "Open" from the context menu
   - Click "Open" in the security dialog


## Development Setup

1. Clone the repository
2. Copy `src/config/secure.template.js` to `src/config/secure.js`
3. Add your Spotify API credentials to `secure.js`
4. Run `npm install`
5. Run `npm start` to launch the development version