// test/anti-spiral.test.mjs — thin entry-point shim. The harness itself is
// TypeScript in src/test/anti-spiral.test.ts and is compiled to
// dist/test/anti-spiral.test.js by `npm run build`.
//
// `node test/anti-spiral.test.mjs` behaves exactly as before: it drives the
// plugin (the shim at ../anti-spiral.js, or $ANTI_SPIRAL_PLUGIN) and exits 1 on
// any failed case. ANTI_SPIRAL_STATE_DIR is set by the compiled harness before it
// loads the plugin.
import "../dist/test/anti-spiral.test.js"
