# [vault]

**Live:** https://vault.choseroxy.workers.dev/about

Your own place for work-in-progress music: projects and folders, sorting by BPM, key and tags, share links that show who listened, an editor that writes changes into the file, offline listening, and voice-memo recording. It works on iPhone, PC and laptop, has no file limit, and costs $0.

- **App + API:** a Cloudflare Worker (`worker.js`), free
- **Library data:** Cloudflare D1 (`schema.sql`), free
- **Audio files:** Backblaze B2, free for 10 GB with no card needed
- **Frontend:** plain HTML/JS in `public/`, installable on iPhone via *Add to Home Screen*

## Try it on your computer first (no accounts needed)

```bash
npm install
```

```bash
npm run db:local
```

```bash
npm run dev:local
```

Open http://localhost:8787. The password is whatever is in `.dev.vars` (create the file with one line: `APP_PASSWORD=pick-something`). Files are stored in a simulated bucket on your computer.

> On Windows, if `db:local` fails with "internal error", your folder path is too long. Move the project somewhere shorter, like `C:\code\vault`.

## Using it

- **Upload:** tap Upload, or drag files onto the page. Dragging a folder makes it a project, and an image inside becomes the cover. Uploads with no project selected go to "Inbox".
- **Allowed files:**
  - Audio: mp3, wav, flac, m4a, aac, ogg, opus, aiff, weba
  - Cover art: jpg, jpeg, png, webp, heic
  - Anything else is refused. Every upload is also checked by its contents, so a renamed `.exe` gets deleted.
- **Sort and filter:** use the toolbar (Custom order, Newest, Name, BPM, Key, Length, tags). Set BPM, key and tags under a track's ⋯ → Details & versions. In Custom order, drag rows to reorder them, or drag a track onto a project in the sidebar to move it.
- **Editor (⋯ → Edit audio):** you hear changes live. **Apply to file** writes them into the audio and saves it as a 24-bit WAV.
  - **Speed & pitch:** varispeed, tempo (keeps pitch), pitch (keeps tempo)
  - **EQ:** parametric, up to 8 bands. Drag the dots; scroll over a dot to change its Q.
  - **Dynamics:** compressor with a gain-reduction meter, limiter
  - **Gain & pan:** input and output gain, pan
  - **Waveform tools:** trim, cut, silence, fade in/out, normalize, reverse, mono, loop, undo
  - **Presets:** saved to your account, so they show up on every device
- **Versions:** every Apply keeps the previous file. Switch back, preview or delete old ones under Details & versions. Old versions count toward your 10 GB.
- **Share:** create a link from Share, with an optional password and expiry. Listeners enter their name, and the 🎧 count shows who played what. Turn a link off at any time.
- **Offline:** use ⋯ → Save offline, or Save all offline on a project. Saved tracks play with no connection.
- **Record:** captures an idea from the microphone into the current project.

## Accounts for other people

You're the admin: sign in with just your password (leave the username empty). Other people get their own account,
and their music is kept in **their own Google Drive** (15 GB free each), so it never uses your Backblaze space.
Nobody can see anyone else's projects; share links work the same as yours.

1. One-time Google setup (free): in [Google Cloud console](https://console.cloud.google.com/) make a project, turn on
   the **Google Drive API**, set up the **OAuth consent screen** (External, add the scope `.../auth/drive.file`, then **Publish app**:
   apps left in Testing are signed out of Drive every 7 days, and `drive.file` needs no Google review), then **Credentials → Create OAuth client ID →
   Web application** with the redirect URI `https://vault.choseroxy.workers.dev/api/drive/callback`.
2. Run `node setup.mjs google` and paste the client ID and secret.
3. In [vault], **Settings → [account] → People → New invite code**, and send the code. They choose **Sign up** on the
   login screen, pick a username, password and picture, then tap **Connect Google Drive**.

Keep `APP_PASSWORD` as it is once others have accounts: their passwords and Drive connections are tied to it.

## Limits worth knowing

- An iPhone web app can't appear in the share sheet (AirDrop, iMessage). Save the file to Files, then upload.
- Old iPhones can't play Ogg/Opus, and Chrome can't play AIFF. Those files still store fine and can be downloaded.
- The editor works at 44.1 kHz. Files at other sample rates are converted when you apply edits.
- Editing needs a connection. Offline mode is for listening.
- Shared links are view and listen only.

## Files

| File | What it is |
|---|---|
| `worker.js` | API, login, upload checks, share pages, B2 URL signing |
| `share-page.js` | The public listen page for share links |
| `schema.sql` | Database tables |
| `public/app.js` | Library, uploads, player, sharing, offline, recording |
| `public/editor.js` | The audio editor |
| `public/types.js` | Allowed file types and file-signature checks (shared by app and Worker) |
| `public/wav.js` | 24-bit WAV encoder |
| `public/lib/` | SoundTouch (pitch/tempo) and heic2any (iPhone photos on PC) |
| `test.mjs` | `npm test`: checks the file-type rules and WAV encoder |
