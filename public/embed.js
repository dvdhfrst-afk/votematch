/*
 * embed.js - one-line embeddable loader for the Utah ballot widget.
 *
 * A newsroom pastes ONE tag where the widget should appear:
 *
 *   <script src="https://YOUR-DOMAIN/embed.js" data-partner="salt-lake-tribune" async></script>
 *
 * This script injects a responsive, auto-resizing iframe pointed at
 * /embed/utah?partner=<data-partner>. The iframe's origin is derived from THIS
 * script's own src, so the newsroom never edits a URL. The widget posts its
 * height back and this loader keeps the iframe sized to fit (no inner scroll).
 *
 * Raw fallback (no JavaScript): a newsroom can instead paste a plain iframe:
 *   <iframe src="https://YOUR-DOMAIN/embed/utah?partner=salt-lake-tribune"
 *           style="width:100%;border:0;height:900px" title="Your ballot, explained"></iframe>
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */
(function () {
  var HEIGHT_MESSAGE = 'havesay:embed:height';
  var script = document.currentScript;
  if (!script) return;

  // Origin = where this script was served from.
  var origin;
  try {
    origin = new URL(script.src).origin;
  } catch (e) {
    return;
  }

  var partner = script.getAttribute('data-partner') || '';
  var path = script.getAttribute('data-path') || '/embed/utah';
  var initialHeight = parseInt(script.getAttribute('data-height') || '1000', 10);

  var src = origin + path + (partner ? '?partner=' + encodeURIComponent(partner) : '');

  var iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.title = 'Your ballot, explained';
  iframe.setAttribute('loading', 'lazy');
  iframe.setAttribute('scrolling', 'no');
  iframe.style.width = '100%';
  iframe.style.maxWidth = '100%';
  iframe.style.border = '0';
  iframe.style.display = 'block';
  iframe.style.height = initialHeight + 'px';
  // Allow the widget's outbound links (source receipts, "open the full app")
  // to open in a new tab.
  iframe.setAttribute('allow', 'clipboard-write');

  // Insert right after the script tag so the widget lands where it was pasted.
  if (script.parentNode) {
    script.parentNode.insertBefore(iframe, script.nextSibling);
  } else {
    document.body.appendChild(iframe);
  }

  // Auto-resize from the widget's postMessage height reports (origin-checked).
  window.addEventListener('message', function (event) {
    if (event.origin !== origin) return;
    var data = event.data;
    if (!data || data.type !== HEIGHT_MESSAGE) return;
    var h = parseInt(data.height, 10);
    if (h && h > 0) iframe.style.height = h + 'px';
  });
})();
