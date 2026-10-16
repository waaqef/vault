# [vault]

**Live:** https://vault.choseroxy.workers.dev/about

**iPhone app:** [waaqef/vault-ios](https://github.com/waaqef/vault-ios) (a sideloadable `.ipa` with real haptics, background playback and downloads; [latest build](https://github.com/waaqef/vault-ios/releases/download/latest/vault.ipa))

Your own place for work-in-progress music: projects and folders, sorting by BPM, key and tags, share links that show who listened, an editor that writes changes into the file, offline listening, and voice-memo recording. It works on iPhone, PC and laptop, has no editing limits, and costs $0.

- **App + API:** a Cloudflare Worker (`worker.js`), free
- **Library data:** Cloudflare D1 (`schema.sql`), free
- **Audio files:** Backblaze B2, free for 10 GB with no card needed
- **Frontend:** plain HTML/JS in `public/`, installable on iPhone via *Add to Home Screen*
- **iPhone app:** a small native shell around the web app, in its own repo: [vault-ios](https://github.com/waaqef/vault-ios)

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

- **Upload:** tap Upload, or drag files onto the page. Dragging a folder makes it a project, and an image inside becomes the cover. Uploads with no project selected go to your newest project (new accounts make their first project when they sign up).
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
- **Share links:** create a link from Share, with an optional password, expiry and downloads on or off. People signed in to [vault] hear full songs, can comment and can save it to their library; everyone else hears 5-second previews unless you make the link **Public**. The 🎧 count shows who played what. Turn a link off or delete it at any time.
- **People:** in Share, add [vault] users by username as **Can listen** or **Can edit**. It shows up in their library under [shared with me] and plays in their app, offline too. Editors can add, remove, reorder and edit tracks (their files go into your storage); only you can delete or share the project. Comments and **Activity** (⋯ menu) show what everyone did.
- **Offline:** use ⋯ → Save offline, or Save all offline on a project. Saved tracks play with no connection.
- **Record:** captures an idea from the microphone into the current project.

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
