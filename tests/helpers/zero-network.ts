// The zero-network scan for a rendered report (#37), shared by the renderer's tests
// and GET /api/report's (#39) so both hold the HTML to the same rule.
import { expect } from "bun:test";
import { QUOTA_DOCS_URL, REPO_URL } from "../../server/src/report/render";

const EMBED = /<script type="application\/json" id="yald-report">([\s\S]*?)<\/script>/;

/** No stylesheet, script, image or font is fetched; the only links point into the repository. */
export function expectNoNetworkReferences(html: string, yaldVersion: string): void {
  for (const needle of ["<link", 'src="http', "@import", "url(http"]) expect(html.toLowerCase()).not.toContain(needle);
  expect(html).not.toMatch(/\ssrc=/i);
  expect(html.match(/<script/g)).toHaveLength(1);
  // The only absolute URLs outside the embedded payload are the credit and the quota docs link.
  const urls = html.replace(EMBED, "").match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) expect(url === REPO_URL || url.startsWith(`${REPO_URL}/`)).toBe(true);
  expect(html).toContain(`<a href="${REPO_URL}">Numbers from yald v${yaldVersion}</a>`);
  expect(html).toContain(`href="${QUOTA_DOCS_URL}"`);
}
