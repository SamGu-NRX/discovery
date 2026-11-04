// Fixture x.com pages: every click is reported to /__log so the test can
// prove what the session touched.
document.addEventListener("click", (event) => {
  const name = event.target.closest("[data-name]")?.dataset.name ?? event.target.tagName;
  navigator.sendBeacon("/__log", JSON.stringify({ click: name, path: location.pathname }));
}, true);

function graphql(op, variables, viaXhr) {
  const url = `/i/api/graphql/fixtureQueryId/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`;
  if (!viaXhr) return fetch(url).then((r) => r.text());
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.onload = () => resolve(xhr.responseText);
    xhr.send();
  });
}

function selectTab(tab) {
  for (const t of tab.parentElement.querySelectorAll('[role="tab"]')) t.setAttribute("aria-selected", String(t === tab));
}
