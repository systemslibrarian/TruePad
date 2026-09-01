/* ============================================================================
 * QR render — a module matrix to a crisp inline SVG
 * ----------------------------------------------------------------------------
 * SVG, not a bitmap: the symbol stays sharp at any display size, which is what
 * a version-34 (153×153) code needs to be scannable on a phone. Modules are
 * drawn as source-built <rect> elements via createElementNS — never innerHTML —
 * so nothing dynamic is ever parsed as markup, matching the rest of the UI.
 *
 *   · dark modules on a light ground (conventional; anything else hurts scans);
 *   · one merged path-free grid of unit rects on an integer coordinate system,
 *     so a viewer scales it by whole modules with no blur and no seams;
 *   · a 4-module quiet zone (the QR spec minimum) baked into the viewBox;
 *   · no logo, no rounded modules, no colour — decoration is a scan failure.
 * ========================================================================= */

import type { QrMatrix } from "./encode.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

/** QR spec minimum quiet zone, in modules, on every side. */
export const QUIET_ZONE_MODULES = 4;

export interface QrSvgOptions {
  /** Accessible label for the symbol (role="img"). */
  label: string;
}

/**
 * Render a QR matrix to an inline SVG element. The SVG uses a 1-unit-per-module
 * coordinate system with a baked-in quiet zone; CSS sizes it responsively while
 * the browser keeps modules on integer boundaries.
 */
export function renderQrMatrixToSvg(matrix: QrMatrix, opts: QrSvgOptions): SVGSVGElement {
  const inner = matrix.size;
  const full = inner + QUIET_ZONE_MODULES * 2;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "qr-svg");
  svg.setAttribute("viewBox", `0 0 ${full} ${full}`);
  svg.setAttribute("width", String(full));
  svg.setAttribute("height", String(full));
  // Crisp module edges regardless of the rendered size.
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", opts.label);

  // The light ground is the whole viewBox, so the quiet zone is genuinely quiet.
  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", String(full));
  bg.setAttribute("height", String(full));
  bg.setAttribute("fill", "#ffffff");
  svg.appendChild(bg);

  // Dark modules. Runs of horizontally-adjacent dark modules merge into one
  // rect so the DOM stays small (a version-34 symbol is ~23k modules).
  const dark = document.createElementNS(SVG_NS, "path");
  let d = "";
  for (let row = 0; row < inner; row++) {
    let runStart = -1;
    for (let col = 0; col <= inner; col++) {
      const on = col < inner && matrix.isDark(row, col);
      if (on && runStart < 0) {
        runStart = col;
      } else if (!on && runStart >= 0) {
        const x = runStart + QUIET_ZONE_MODULES;
        const y = row + QUIET_ZONE_MODULES;
        d += `M${x} ${y}h${col - runStart}v1h${-(col - runStart)}z`;
        runStart = -1;
      }
    }
  }
  dark.setAttribute("d", d);
  dark.setAttribute("fill", "#000000");
  svg.appendChild(dark);

  return svg;
}
