// Which build of the extension a run ran on. The extension is loaded
// unpacked from a git checkout, and nothing in it names its commit: bundles
// carried only the manifest's "0.1.0", so a report could not show which
// build ran (the discovery lead, Nov 15). The reload procedure writes
// app/build.json ({ "commit": "<sha>" }, git-ignored) just before it
// restarts the extension, and every daily record and bundle carries it.
// It reads the file when asked, so it names the files on disk; a checkout
// changed without a reload would show the new commit early.

export async function loadedBuild() {
  try {
    const res = await fetch(chrome.runtime.getURL("build.json"), { cache: "no-store" });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.commit === "string" && /^[0-9a-f]{7,40}$/.test(body.commit) ? body.commit : null;
  } catch {
    return null;
  }
}
