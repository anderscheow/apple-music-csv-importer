# Tracklist

A local web app for finding Apple Music catalog matches from a CSV and adding them to a playlist. Review matches before importing, avoid duplicate additions, and export songs that need further attention.

## Requirements

- Node.js 22.10 or later and npm.
- An Apple Music account with an active subscription and a library that can be accessed through MusicKit.
- An Apple Developer account with a MusicKit-enabled Media ID and a Media Services private key. Follow [Apple's setup instructions](https://developer.apple.com/help/account/capabilities/create-a-media-identifier-and-private-key).

## Get started

1. Clone the repository and install dependencies:

   ```sh
   git clone git@github.com:anderscheow/apple-music-csv-importer.git
   cd apple-music-csv-importer
   npm ci
   ```

2. Copy the example configuration:

   ```sh
   cp .env.example .env
   ```

3. Set `APPLE_TEAM_ID` and `APPLE_MUSIC_KEY_ID` in `.env`. Set either `APPLE_MUSIC_PRIVATE_KEY_PATH` to the absolute path of your downloaded `.p8` key, or `APPLE_MUSIC_PRIVATE_KEY` to its PEM contents with `\n` between lines. The path takes precedence when both are set. Keep `.env` and the private key private.
4. Start the app:

   ```sh
   npm run dev
   ```

5. Open <http://127.0.0.1:5173>, connect Apple Music, choose a destination, and upload a CSV.

For a production build, run `npm run build` followed by `npm start`. The local server serves the built app at <http://127.0.0.1:3001>. A secure HTTPS origin and an appropriate security review are needed before exposing the app publicly.

## CSV format

Use a header row with `title,artist,album,isrc`. Title and artist are required; album and ISRC may be blank. Alternate title and artist headers such as `Song`, `Track`, and `Artist Name` are supported. Standard CSV quoting is supported.

```csv
title,artist,album,isrc
Dreams,Fleetwood Mac,Rumours,
"Song, Part Two",Example Artist,,
```

Download the sample CSV from the app or use [public/sample-playlist.csv](public/sample-playlist.csv). Imports are limited to 5,000 rows per file. If present, an ISRC is used for an exact catalog lookup; otherwise the app searches by title and artist.

## Matching and review

The app searches the connected account's storefront and lets you review each selection. **Prefer remastered** prioritizes remasters among returned results; **Search further for remasters** performs an additional search when needed. **Skip live versions** filters recordings marked live in the title or album. These are heuristics, so check the proposed matches.

**Deep search for unmatched songs** runs an optional second pass after the standard search. It checks artist aliases and title variations and, for Chinese songs, searches Chinese-language catalog results for an equivalent in your storefront. It takes longer and only processes songs without a match. You can also enable it after a standard search and choose **Deep search unmatched**, keeping your existing selections. A localized result is selected automatically when its title and artist match and the storefront recording has the same catalog ID or ISRC. Other possibilities are shown as unselected suggestions; some may be unrelated.

For large files, matching uses up to three concurrent searches. Review results in pages of 100 or filter them by title, artist, or status. **Pause matching** finishes requests in progress, and **Resume matching** continues the remaining rows in the same browser session. Progress is held in memory and is lost when the page is reloaded. **Retry failed searches** retries failed rows.

**Export missing** downloads a CSV of unconfirmed suggestions, unmatched songs, and failed searches. Its reason column distinguishes them. Skipped live songs and manually skipped matches are excluded. When matching is paused, **Export missing so far** exports completed results. The exported file can be edited and imported again.

## Playlist behavior and privacy

- CSV parsing and match selection happen in the browser; CSV files are not uploaded to the server.
- The local server signs short-lived developer tokens and forwards Apple Music API calls. The private key never reaches the browser. The Apple Music user token is sent to the local server for API requests and is not stored by this project.
- Read-only playlists are listed but cannot be selected as destinations. **Prevent duplicates** compares the destination playlist and repeated CSV selections by catalog ID or normalized title and artist.
- Songs are appended in CSV order in batches of 100. If a later batch fails, the app reports how many were added and leaves the remaining songs selected for retry.
- **Make a copy without live songs** creates a new playlist with the original's non-live tracks in order, then adds selected CSV songs. It also works without a CSV. Apple's public playlist API does not offer track removal, so the original stays unchanged. Some library-only or unavailable tracks may not be copyable.
- Playlist CSV files, generated reports, `.env` files, and private keys are ignored by Git; the public sample CSV is included.

## Troubleshooting

- **`DECODER routines::unsupported`**: Check that the `.p8` file is complete PEM data, including its header and footer on separate lines. If using the inline environment variable, preserve the `\n` separators shown in `.env.example`. Restart the server after changing `.env`.
- **Missing or unexpected matches**: Verify the account's storefront, try deep search, and review suggestions. Catalog availability and display names vary by storefront.
- **Search failures**: Use **Retry failed searches**. Apple Music can rate-limit requests, particularly for large files.

## Development

```sh
npm test       # Node's built-in test runner
npm run build  # TypeScript check and Vite production build
```

`npm run dev:client` and `npm run dev:server` start the client and API separately. See [AGENTS.md](AGENTS.md) for AI agent guidance and [CHANGELOG.md](CHANGELOG.md) for project changes. GitHub Actions runs the test and build checks on Node 22 and 24.

## Apple API references

- [Generate developer tokens](https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens)
- [List library playlists](https://developer.apple.com/documentation/applemusicapi/get-all-library-playlists)
- [Get a library playlist's tracks](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-5l22w)
- [Create a library playlist](https://developer.apple.com/documentation/applemusicapi/create-a-new-library-playlist)
- [Add tracks to a playlist](https://developer.apple.com/documentation/applemusicapi/add-tracks-to-a-library-playlist)
- [Look up catalog songs by ISRC](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-songs-by-isrc)
- [Get equivalent catalog songs](https://developer.apple.com/documentation/applemusicapi/get-equivalent-ids-for-the-albums-3ce20)
