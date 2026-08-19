/**
 * Opens a URL in a new tab via an explicit, synchronous window.open() call
 * instead of a plain `<a target="_blank">`. Some of the deployment links
 * this powers point at live phishing-clone sites, and a handful of browsers
 * (and the destination pages themselves, via window.opener/referrer checks)
 * treat a bare anchor's new-tab open as an ambiguous same-tab navigation and
 * throw up a "leave this site?" confirmation. A direct window.open() call
 * with noopener/noreferrer removes that ambiguity - it's unmistakably a new
 * window, not a navigation away from the current page.
 */
export function openExternalLink(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}
