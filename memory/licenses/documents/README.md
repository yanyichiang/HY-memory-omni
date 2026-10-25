# Document and PNG runtime license texts

These are the actual package versions used by the document parser and existing PNG derivative path. Package license texts are copied from the installed distributions without replacing their copyright statements. `INVENTORY.json` records exact versions, package tarball URLs and package-relative original source paths; no machine installation path is required.

| Package | Version | Declared license | Retained files |
| --- | --- | --- | --- |
| `pdf-lib` | 1.17.1 | MIT | [pdf-lib-1.17.1-LICENSE.md](pdf-lib-1.17.1-LICENSE.md) |
| `@pdf-lib/standard-fonts` | 1.0.0 | MIT | [pdf-lib-standard-fonts-1.0.0-LICENSE.md](pdf-lib-standard-fonts-1.0.0-LICENSE.md) |
| `@pdf-lib/upng` | 1.0.1 | MIT | [pdf-lib-upng-1.0.1-LICENSE](pdf-lib-upng-1.0.1-LICENSE) |
| `pako` | 1.0.11 | (MIT AND Zlib) | [pako-1.0.11-LICENSE](pako-1.0.11-LICENSE) |
| `tslib` | 1.14.1 | 0BSD | [tslib-1.14.1-CopyrightNotice.txt](tslib-1.14.1-CopyrightNotice.txt), [tslib-1.14.1-LICENSE.txt](tslib-1.14.1-LICENSE.txt) |
| `fflate` | 0.8.3 | MIT | [fflate-0.8.3-LICENSE](fflate-0.8.3-LICENSE) |
| `fast-xml-parser` | 5.11.2 | MIT | [fast-xml-parser-5.11.2-LICENSE](fast-xml-parser-5.11.2-LICENSE) |
| `@nodable/entities` | 3.1.0 | MIT | [nodable-entities-3.1.0-upstream-LICENSE](nodable-entities-3.1.0-upstream-LICENSE) |
| `anynum` | 1.0.1 | MIT | [anynum-1.0.1-LICENSE](anynum-1.0.1-LICENSE) |
| `fast-xml-builder` | 1.3.1 | MIT | [fast-xml-builder-1.3.1-LICENSE](fast-xml-builder-1.3.1-LICENSE) |
| `is-unsafe` | 2.0.2 | MIT | [is-unsafe-2.0.2-LICENSE](is-unsafe-2.0.2-LICENSE) |
| `path-expression-matcher` | 1.6.2 | MIT | [path-expression-matcher-1.6.2-LICENSE](path-expression-matcher-1.6.2-LICENSE) |
| `strnum` | 2.5.1 | MIT | [strnum-2.5.1-LICENSE](strnum-2.5.1-LICENSE) |
| `xml-naming` | 0.3.0 | MIT | [xml-naming-0.3.0-LICENSE](xml-naming-0.3.0-LICENSE) |
| `fast-png` | 8.0.0 | MIT | [fast-png-8.0.0-LICENSE](fast-png-8.0.0-LICENSE) |
| `iobuffer` | 6.0.1 | MIT | [iobuffer-6.0.1-LICENSE](iobuffer-6.0.1-LICENSE) |

`tslib@1.14.1` is the copy nested under pdf-lib; its own 0BSD license and CopyrightNotice are included, rather than substituting a different root tslib version. `fflate@0.8.3` matches the existing image dependency pin.

The npm distribution of `@nodable/entities@3.1.0` declares MIT but omits a LICENSE file. Its exact registry version metadata identifies gitHead `ac48e7ea591da372be023a481875c747535812b3`; the retained license comes from that upstream repository commit, not an inferred MIT template. The provenance URL is in INVENTORY.json.

## PDF.js / XPDF stream notices

[pdf-lib-1.17.1-PDFJS-STREAM-NOTICES.txt](pdf-lib-1.17.1-PDFJS-STREAM-NOTICES.txt) retains all eight Apache-related source comments from the seven `pdf-lib/src/core/streams/*.ts` files (FlateStream contains two). This includes Mozilla Foundation and Glyph & Cog copyright statements. [Apache-2.0.txt](Apache-2.0.txt) is the full Apache License 2.0 text copied from this project's root LICENSE; that copy supplies the license text, not new ownership of the stream code. Keep the original comments in modified/generated stream source as well as these notices in redistribution. The top-level pdf-lib MIT license does not replace the embedded Apache obligations.

## pako Zlib and MIT

The pako package LICENSE is MIT, while its zlib-port JavaScript files include the additional Zlib terms. [pako-1.0.11-ZLIB-NOTICES.txt](pako-1.0.11-ZLIB-NOTICES.txt) retains the complete source notice blocks from eleven files, including their original copyright lines and alteration/origin conditions. Both sets of terms are retained; the package's `(MIT AND Zlib)` declaration is not reduced to MIT.

These files cover this enumerated runtime dependency set, not an installed development environment or a blanket clearance for every project dependency. Build/distribution code must carry this directory with the corresponding document implementation. No model or production data is present.
