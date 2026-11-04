// anti-spiral.js — thin entry-point shim. The plugin itself is TypeScript in
// src/anti-spiral.ts and is compiled to dist/anti-spiral.js (`npm run build`).
//
// This path is kept because the README, test/anti-spiral.test.mjs and any install
// that copies the file expect `anti-spiral.js` here. It is not loaded from the
// opencode plugin directory on its own: copy this file together with dist/.
"use strict"

let impl
try {
  impl = require("./dist/anti-spiral.js")
} catch (err) {
  if (err && err.code === "MODULE_NOT_FOUND") {
    throw new Error(
      "anti-spiral: dist/anti-spiral.js is missing — run `npm run build` in the anti-spiral repo",
    )
  }
  throw err
}

const plugin = impl.default || {}
const server = plugin.server || impl.AntiSpiral

// Named assignments (not module.exports) so both `require()` and `import()` see
// every export: opencode reads the plugin's default/server key, the test suite
// destructures AntiSpiral.
exports.AntiSpiral = impl.AntiSpiral
exports.detectSpiral = impl.detectSpiral
exports.detectTailLoop = impl.detectTailLoop
exports.id = plugin.id || "anti.spiral"
// The loader key, exposed at the top level as well as under `default`, so a
// CommonJS consumer sees the same shape as the compiled ES module default.
exports.server = server
exports.default = { ...plugin, id: plugin.id || "anti.spiral", server }
