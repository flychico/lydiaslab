"""Price chart with Lynold's Fib levels, as one inline SVG (for Market Desk notes and the Obsidian vault).

Usage:
    from chart_svg import chart_svg
    svg = chart_svg("XOM", bars, levels, title="XOM · daily · your extension levels")

bars:   list of (date "YYYY-MM-DD", open, high, low, close), oldest first. ~60-160 bars reads best.
        About 18% of the plot width is left empty after the last bar, so the latest candles stay clear of the labels.
levels: list of dicts {"p": price, "t": "2.0 ext", "c": "white" | "gold" | "cyan" | "green" | "red" | "dim",
                        "dash": True (extension style) / False (solid: retracement anchors, 50%, stops)}
        Lynold's colors: white = 0.5 / 2.0 / 3.0, gold = 0.786 / 1.618 / 2.618, cyan = 1.382 / 2.382.
        Use green for a trigger/target you add, red for a stop.
Levels far outside the visible price range are listed under the chart instead of squashing it.

The SVG carries explicit colors (so it renders in Obsidian and anywhere else) plus class names that the
Market Desk page restyles for light and dark mode. It must stay on lines that start with "<svg" so the
Market Desk renderer passes it through; keep it as one block with no blank lines inside.
"""
from html import escape

W, H = 760, 400
PAD_L, PAD_R, PAD_T, PAD_B = 8, 150, 34, 26
COLORS = {"white": "#20242C", "gold": "#B8912F", "cyan": "#1B8FA8", "green": "#2F6E4A", "red": "#A63A2E", "dim": "#6B6152"}


def _fmt(p):
    return f"${p:,.2f}" if p < 1000 else f"${p:,.0f}"


def chart_svg(sym, bars, levels, title=None, now=None):
    bars = [b for b in bars if b and b[2] is not None][-160:]
    if not bars:
        return ""
    lo = min(b[3] for b in bars)
    hi = max(b[2] for b in bars)
    span = hi - lo or 1
    vis_lo, vis_hi = lo - span * 0.35, hi + span * 0.35
    shown = sorted([l for l in levels if vis_lo <= l["p"] <= vis_hi], key=lambda l: -l["p"])
    hidden = [l for l in levels if not (vis_lo <= l["p"] <= vis_hi)]
    ymin = min([lo] + [l["p"] for l in shown]) - span * 0.04
    ymax = max([hi] + [l["p"] for l in shown]) + span * 0.04
    ph, pw = H - PAD_T - PAD_B, W - PAD_L - PAD_R
    y = lambda p: PAD_T + (ymax - p) / (ymax - ymin) * ph
    n = len(bars)
    # Empty space after the last bar (Lynold, Nov 10: "need more bars to the right so the chart doesn't look so
    # cluttered"), like the right margin on a trading platform, so the latest candles never sit on the level labels.
    slots = n + max(8, round(n * 0.18))
    step = pw / slots
    bw = max(1.2, step * 0.62)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" data-ticker="{escape(sym)}" viewBox="0 0 {W} {H}" role="img" aria-label="{escape(title or sym)} chart" font-family="Arial, sans-serif">']
    out.append(f'<text x="{PAD_L}" y="18" font-size="13" font-weight="700" fill="#20242C" class="c-ink">{escape(title or sym)}</text>')
    # light grid: 4 price rules
    for k in range(5):
        p = ymin + (ymax - ymin) * k / 4
        out.append(f'<line x1="{PAD_L}" x2="{PAD_L + pw}" y1="{y(p):.1f}" y2="{y(p):.1f}" stroke="#E3DACB" stroke-width="1" class="c-grid"/>')
    # candles
    for i, (d, o, h, l, c) in enumerate(bars):
        o = o if o is not None else c
        up = c >= o
        cls, col = ("c-up", "#2F6E4A") if up else ("c-dn", "#A63A2E")
        cx = PAD_L + step * (i + 0.5)
        out.append(f'<line x1="{cx:.1f}" x2="{cx:.1f}" y1="{y(h):.1f}" y2="{y(l):.1f}" stroke="{col}" stroke-width="1" class="{cls}"/>')
        top, bot = y(max(o, c)), y(min(o, c))
        out.append(f'<rect x="{cx - bw / 2:.1f}" y="{top:.1f}" width="{bw:.1f}" height="{max(1, bot - top):.1f}" fill="{col}" class="{cls}"/>')
    # date ticks: first, middle, last
    for i, anc in ((0, "start"), (n // 2, "middle"), (n - 1, "middle")):
        cx = PAD_L + step * (i + 0.5)
        out.append(f'<text x="{cx:.1f}" y="{H - 8}" font-size="10" text-anchor="{anc}" fill="#6B6152" class="c-dim">{escape(bars[i][0][5:])}</text>')
    # levels, with labels spread so they never overlap
    placed = []
    for l in shown:
        ly = y(l["p"])
        col = COLORS.get(l.get("c", "dim"), COLORS["dim"])
        cls = "l-white" if l.get("c") == "white" else ""
        dash = ' stroke-dasharray="6 4"' if l.get("dash", True) else ""
        out.append(f'<line x1="{PAD_L}" x2="{PAD_L + pw}" y1="{ly:.1f}" y2="{ly:.1f}" stroke="{col}" stroke-width="1.4"{dash} class="{cls}"/>')
        ty = ly + 4
        for py in placed:
            if abs(ty - py) < 13:
                ty = py + 13
        placed.append(ty)
        tcls = ' class="t-white"' if l.get("c") == "white" else ""
        out.append(f'<text x="{PAD_L + pw + 6}" y="{ty:.1f}" font-size="11" fill="{col}"{tcls}><tspan font-weight="700">{escape(_fmt(l["p"]))}</tspan> {escape(l.get("t", ""))[:22]}</text>')
    # last price marker
    last = now if now is not None else bars[-1][4]
    out.append(f'<circle cx="{PAD_L + step * (n - 0.5):.1f}" cy="{y(last):.1f}" r="3.5" fill="#C9A84C" stroke="#20242C" stroke-width="1"/>')
    if hidden:
        txt = " · ".join(f'{l.get("t", "")} {_fmt(l["p"])}' for l in sorted(hidden, key=lambda l: -l["p"]))
        out.append(f'<text x="{PAD_L}" y="{PAD_T - 6}" font-size="10" fill="#6B6152" class="c-dim">Off chart: {escape(txt)[:140]}</text>')
    out.append("</svg>")
    return "".join(out)  # one line on purpose: no blank lines inside the block
