# Contributing to Pointy

Thanks for helping out. Pointy is a small project, so this page is short.

## Issues first, for anything bigger than a small fix

Typos, small bug fixes and doc fixes can go straight to a pull request. For a new feature, a behavior change or a large refactor, open an issue first so we can agree on the approach before you spend time on it.

When you report a bug, include your Windows version, the Pointy plugin version (shown in DSH's plugin manager), which app or website you were pointing at, and the relevant lines from `%USERPROFILE%\.pointy\error.log`.

## Running it locally

Pointy is a Windows (10/11, x64) Electron app. You need Node.js and npm.

```bash
npm install
npm start
```

Pointy normally gets its sessions and answers from the DSH plugin. Without DSH you can still test picking and the card: run `npm run fake` to push a fake set of plugin state.

The dev build and the one the plugin starts share `%USERPROFILE%\.pointy` and port 47321, so quit the installed Pointy first. Use `POINTY_PORT` to run on another port. The browser extension lives in `extension/`; load it unpacked from `chrome://extensions` or `edge://extensions`.

The README's "开发" section explains the folder layout and how to pack the plugin.

## Pull requests

- Keep one change per pull request. A bug fix and a refactor are two pull requests.
- Write in the description how you tested it. Most of Pointy (shaking, picking, highlights, the card) can only be checked by hand on a real desktop, so say what you tried, in which apps, and what you saw. A screenshot or short GIF helps for anything visual.
- Link the issue with `Fixes #N`. Use `Refs #N` if the change helps but you're not sure it closes the issue.
- Commit titles follow the existing history: an area, a colon, then what changed, for example `Pick: clip the highlight to the visible part of the element`.
- Don't commit anything personal: user paths, tokens, or screenshots that show private content.

Maintainers push branches to this repository; everyone else works from a fork. Either way, changes reach `main` through a reviewed pull request.

## AI tools

You can use AI tools to write code or text. You are still the author: read and understand everything you submit, test it yourself, and be ready to explain it in review. Pull requests that look generated and untested, especially large ones, will be closed.

## License

Code contributions are released under the [MIT License](LICENSE). The mascot artwork is not MIT; see [ASSETS.md](ASSETS.md) before changing or adding art.
