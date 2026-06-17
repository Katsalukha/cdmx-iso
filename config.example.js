// OPTIONAL local-dev convenience so you don't paste the key into the modal each time.
//
//   1. Copy this file to `config.local.js` (gitignored) and put your real key in it.
//   2. Add this line to index.html, right BEFORE the importmap <script>:
//        <script src="./config.local.js"></script>
//
// app.js reads window.CDMX_GOOGLE_KEY first, then localStorage, then the modal.
// Do NOT commit config.local.js. For the deployed site, prefer the in-app modal
// (key stored per-browser) + an HTTP-referrer-restricted key.

window.CDMX_GOOGLE_KEY = 'PASTE_YOUR_GOOGLE_MAPS_TILES_API_KEY_HERE';
