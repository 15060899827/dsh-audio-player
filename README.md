# dsh-audio

An inline audio player for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH).

When the agent produces a sound — a voice clip, a song, a generated melody — this
plugin renders it **directly in the conversation** as a player you can click. No
file manager, no "open this path yourself", no second app.

```text
agent calls play_audio(path)
        │
        ├─ host:  registers the play_audio tool + a streaming audio route
        └─ client: renders <audio controls> in the transcript (promoted node)
                   and falls back to a card inside the tool-call fold
```

## Install

```sh
dsh plugin --profile web add dsh-audio
```

or, from a checkout:

```sh
dsh plugin --profile web add /path/to/dsh-audio
```

Then restart DSH.

## Use

The agent calls `play_audio` with an absolute path:

```json
{ "path": "C:/Users/me/Music/take-01.wav", "title": "take 01" }
```

You get a player in the transcript. The same result also stays available inside
the collapsed tool call, so it can be replayed later.

## Configuration

Only files under an allow-list may be served — the route is reachable from the
local web port, so "any absolute path" would be a file-read hole. Resolution order:

1. `DSH_AUDIO_ROOTS` — semicolon-separated absolute directories
   ```sh
   set DSH_AUDIO_ROOTS=D:\work\audio;E:\music
   ```
2. `~/.dsh/dsh-audio-roots.json` — a JSON array
   ```json
   ["D:/work/audio", "E:/music"]
   ```
3. Default: the process working directory, plus the user's `Music` and
   `Documents` folders.

## What it does with the request

- **Range requests** — the player can seek; `206` / `416` / `HEAD` are handled.
- **Streaming** — files are piped, never read whole into memory.
- **Type allow-list** — wav, mp3, ogg, opus, m4a, aac, flac, webm.
- **Size cap** — 512 MB per file.

## Development

```sh
node test/verify.mjs   # host: tool registration, path guard, route, Range
node test/client.mjs   # client: component rendering, promotion definition
```

Both run offline: they build a fake cordis context (and a fake module loader for
the browser half), so no DSH instance is needed.

## Limitations

- Paths are matched literally; symlinks are resolved before the allow-list check.
- The promoted node needs a host that exposes `uiConversation`. On older hosts the
  player still appears, just inside the tool-call fold.

## License

MIT
