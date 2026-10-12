function normalizeInnerHTML(actualHTML: string) {
  // Strip GXT rendering artifacts
  if (__GXT_MODE__) {
    actualHTML = actualHTML
      // Remove GXT placeholder and curried-component boundary comments
      .replace(/<!--(?:placeholder|curried-start|curried-end)[^>]*-->/g, '')
      // Remove empty comments (GXT doesn't produce these like Glimmer VM)
      .replace(/<!---->/g, '')
      .replace(/\s*data-node-id="[^"]*"/g, '')
      .replace(/<\/?ember-outlet[^>]*>/g, '');
  }

  return actualHTML;
}

export default function equalInnerHTML(
  assert: QUnit['assert'],
  fragment: HTMLElement,
  html: string
) {
  let actualHTML = normalizeInnerHTML(fragment.innerHTML);
  let expectedHTML = html;
  // In GXT mode, strip empty comments from expected too
  if (__GXT_MODE__) {
    expectedHTML = expectedHTML.replace(/<!---->/g, '');
  }

  assert.pushResult({
    result: actualHTML === expectedHTML,
    actual: actualHTML,
    expected: expectedHTML,
    message: "innerHTML doesn't match",
  });
}
