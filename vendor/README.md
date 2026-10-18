# Vendored EJS 0.8.0

`yt.solver.lib.js` and `yt.solver.core.js` are unmodified release assets from
https://github.com/yt-dlp/ejs/releases/tag/0.8.0.

EJS is Unlicense; see EJS-LICENSE. The library bundle embeds the ISC notice for
Meriyah and the MIT notice for astring. Preserve those notices when updating.

The app's older vendored JavaScript is deliberately not reused. Server upgrades
must update both files together and run the immutable-player regression tests.

SHA-256:

```
ca259e4e3cdd37d92fc266d9af08d4fd66da8479e240f4d984f29da402c22ead  yt.solver.core.js
770831df5c46474fbff06732315b28f4fb090e427ca669a51da61e2457d41c82  yt.solver.lib.js
```
