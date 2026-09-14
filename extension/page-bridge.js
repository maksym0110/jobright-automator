// Runs in the PAGE's world (not the extension's) so it can wrap window.open.
// While the bot is running, Chrome's popup blocker would silently drop a
// window.open() triggered by a synthetic click. We catch that case and hand
// the URL to the content script, which asks the background to open the tab.
(() => {
  const nativeOpen = window.open.bind(window);
  window.open = function (url, target, features) {
    const botRunning = document.documentElement.dataset.jrbotRunning === "1";
    let win = null;
    try {
      win = nativeOpen(url, target, features);
    } catch {
      win = null;
    }
    if (!win && botRunning && url) {
      const abs = new URL(String(url), location.href).href;
      window.postMessage({ source: "jrbot", type: "openTab", url: abs }, location.origin);
      // Give the caller something window-like so it doesn't crash on null.
      return { closed: false, focus() {}, close() {}, location: { href: abs } };
    }
    return win;
  };
})();
