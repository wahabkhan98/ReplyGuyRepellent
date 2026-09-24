// Every X DOM selector lives here. When X changes its markup, fix it in this file only.
(function (root) {
  const SELECTORS = {
    ARTICLE: 'article[data-testid="tweet"]',
    TEXT: '[data-testid="tweetText"]',
    PERMALINK: 'a[href*="/status/"]',
    // Every real reply has a timestamp; promoted posts don't.
    TIMESTAMP: 'time',
    // Promoted posts are wrapped in this tracker; they are never replies.
    PROMOTED: '[data-testid="placementTracking"]',
  };

  root.RGR = root.RGR || {};
  root.RGR.SELECTORS = SELECTORS;
  if (typeof module !== 'undefined' && module.exports) module.exports = SELECTORS;
})(globalThis);
