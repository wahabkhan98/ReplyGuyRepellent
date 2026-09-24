// Keyword scorer: a pure function with no network, shared by content.js and the node tests.
// scoreKeywords(text) -> "hide" | "keep" | "unsure"
(function (root) {
  // Hide when one of these appears in a reply of 12 words or fewer. Tune freely.
  const PHRASES = [
    'great insight', 'so true', 'thanks for sharing', 'this is gold', 'well said',
    'love this', "couldn't agree more", 'couldnt agree more', 'spot on', 'this is the way',
    'facts', '100%', 'needed this', 'great post', 'amazing post', 'very insightful',
    'game changer', 'underrated', 'bookmarked', 'saving this', 'absolutely', 'this 👆',
    'great thread', 'great point', 'great share', 'great read', 'well put', 'nailed it',
    'thanks for this', 'needed to hear this', 'so insightful', 'very true', 'love it',
    'this is great', 'keep it up', 'big if true', 'exactly this', '💯',
  ];

  // Hide only when the entire reply is one of these. Too common inside real replies to match loosely.
  const EXACT_PHRASES = [
    'this', 'same', 'real', 'agreed', 'exactly', 'wow', 'true', 'interesting', 'yes',
    'amazing', 'insightful', 'nice', 'great', 'following', 'based', 'fr',
  ];

  const MAX_PHRASE_WORDS = 12;
  const LONG_REPLY_WORDS = 20;
  const QUESTION_MIN_WORDS = 6;
  // A reply whose non-phrase leftovers are this short is only filler ("so true bro").
  const FILLER_WORDS = 2;

  const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;
  const LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|io|ai|dev|org|net|co|app|xyz|so|gg|me)\b/;
  const CODE = /`[^`]+`/;
  const NUMBER = /\p{N}/u;

  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const phraseRegex = (p) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(p)}(?![\\p{L}\\p{N}])`, 'gu');
  const PHRASE_REGEXES = PHRASES.map(phraseRegex);

  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[\s.!?,;:…~]+$/u, '');
  }

  function words(text) {
    return text.split(' ').filter((w) => HAS_WORD_CHAR.test(w));
  }

  function scoreKeywords(text) {
    const raw = String(text || '');
    const norm = normalize(raw);
    if (!raw.trim()) return 'keep';

    // Emoji or punctuation only.
    if (!HAS_WORD_CHAR.test(norm)) return 'hide';

    const wordCount = words(norm).length;
    const bare = norm.replace(/[^\p{L}\p{N}' ]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (EXACT_PHRASES.includes(bare)) return 'hide';

    let residual = norm;
    let matched = false;
    for (const re of PHRASE_REGEXES) {
      re.lastIndex = 0;
      if (re.test(residual)) {
        matched = true;
        residual = residual.replace(re, ' ');
      }
    }

    // Nothing but stock phrases, e.g. "100%" or "facts 🔥 so true".
    if (matched && words(residual).length <= FILLER_WORDS) return 'hide';

    if (wordCount >= LONG_REPLY_WORDS) return 'keep';
    if (NUMBER.test(residual) || LINK.test(residual) || CODE.test(raw)) return 'keep';
    if (raw.includes('?') && wordCount >= QUESTION_MIN_WORDS) return 'keep';

    if (matched && wordCount <= MAX_PHRASE_WORDS) return 'hide';
    return 'unsure';
  }

  // Hide thresholds for Jev scores (0-2). Applied in the extension so the slider never re-scores.
  const THRESHOLDS = {
    low: { score: 1.7, confidence: 0.7 },
    medium: { score: 1.4, confidence: 0.6 },
    high: { score: 1.1, confidence: 0.5 },
  };

  // Keyword verdicts use the same shape: hide = score 2 / confidence 1, keep = score 0.
  const KW_HIDE = { score: 2, confidence: 1, source: 'kw' };
  const KW_KEEP = { score: 0, confidence: 1, source: 'kw' };

  function passesThreshold(verdict, strictness) {
    const t = THRESHOLDS[strictness] || THRESHOLDS.medium;
    return verdict.score >= t.score && verdict.confidence >= t.confidence;
  }

  const api = { PHRASES, EXACT_PHRASES, THRESHOLDS, KW_HIDE, KW_KEEP, normalize, scoreKeywords, passesThreshold };
  root.RGR = root.RGR || {};
  Object.assign(root.RGR, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
