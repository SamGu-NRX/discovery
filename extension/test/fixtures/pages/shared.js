// Fixture x.com pages: every click is reported to /__log so the test can
// prove what the session touched.
document.addEventListener("click", (event) => {
  const name = event.target.closest("[data-name]")?.dataset.name ?? event.target.tagName;
  navigator.sendBeacon("/__log", JSON.stringify({ click: name, path: location.pathname }));
}, true);

// The headers and features X's client sends, so fetch mode can learn a
// template from these pages.
const FIXTURE_HEADERS = { authorization: "Bearer fixture-bearer", "x-csrf-token": "fixture-csrf-token", "x-client-transaction-id": "fixture-tid" };

function graphql(op, variables, viaXhr) {
  const features = encodeURIComponent(JSON.stringify({ fixture_feature: true }));
  const url = `/i/api/graphql/fixtureQueryId/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${features}`;
  if (!viaXhr) return fetch(url, { headers: FIXTURE_HEADERS }).then((r) => r.text());
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    for (const [name, value] of Object.entries(FIXTURE_HEADERS)) xhr.setRequestHeader(name, value);
    xhr.onload = () => resolve(xhr.responseText);
    xhr.send();
  });
}

function selectTab(tab) {
  for (const t of tab.parentElement.querySelectorAll('[role="tab"]')) t.setAttribute("aria-selected", String(t === tab));
}
