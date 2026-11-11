# Bundled notice provenance

Retrieved on 2026-11-11. Builds copy these local files alongside the pinned npm/Go dependency versions.

- NotoSansSC-OFL.txt
  Source https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/OFL.txt
  SHA-256 `1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9`

- fontkit-LICENSE.txt
  Source https://raw.githubusercontent.com/foliojs/fontkit/master/LICENSE
  SHA-256 `cf22b8198f0886a8d4626121579114f23141070e1fceab02ab3c1c361e163440`

- Apache-2.0.txt
  Source https://www.apache.org/licenses/LICENSE-2.0.txt
  SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`

The Noto Sans SC font name table identifies version 2.004 and copyright 2014–2021 Adobe, with Reserved Font Name Source. This matches the Google Fonts OFL notice. The exact bundled TTF hash is recorded in frontend-inventory.json.

The npm package @pdf-lib/fontkit 1.1.1 declares MIT in package.json and README.md but omits a standalone license file. The bundle includes the original Fontkit MIT license, the fork README, the Apache 2.0 text for its prebundled Google Brotli code, and copyright/license comments extracted from the exact installed fontkit.es.js.

Other frontend dependencies and their transitive dependencies contribute the license, copyright and notice files present in their installed package roots. The bundle inventory records exact package versions and copied filenames. Go runtime LICENSE/PATENTS and notices from linked Go modules are copied from the pinned toolchain/module cache.
