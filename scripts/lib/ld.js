"use strict";
/**
 * JSON-LD helpers (Leo Manager, 2026-11-18, Lynold's SEO list item 3).
 * Display only: describes pages that already exist; changes no number.
 */
const SITE = "https://ndhorizon.com";
const tag = (obj, id) => `<script type="application/ld+json"${id ? ` id="${id}"` : ""}>${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;

// A results hub: CollectionPage holding an ItemList of the day or week pages.
function resultsList({ url, name, description, items }) {
  return tag({
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name, description, url: SITE + url,
    isPartOf: { "@type": "WebSite", name: "Leo", url: SITE + "/" },
    publisher: { "@type": "Organization", name: "Leo", url: SITE + "/" },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: items.length,
      itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, url: SITE + it.url })),
    },
  }, "ld-results");
}

// Replace the block with this id if the page has one, else add it before </head>.
function put(html, block, id = "ld-results") {
  const re = new RegExp(`<script type="application/ld\\+json" id="${id}">[\\s\\S]*?<\\/script>\\n?`);
  if (re.test(html)) return html.replace(re, block + "\n");
  return html.replace("</head>", block + "\n</head>");
}
const strip = (html, id = "ld-results") => html.replace(new RegExp(`<script type="application/ld\\+json" id="${id}">[\\s\\S]*?<\\/script>\\n?`), "");

module.exports = { tag, resultsList, put, strip, SITE };
