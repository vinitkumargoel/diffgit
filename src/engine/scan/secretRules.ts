/**
 * The secret-scanner rule set (T10.7, atlas tab 14).
 *
 * One module, one explicit table. Every rule is `{ id, description, regex, group?, entropyMin? }`:
 *
 *  - `regex` is a **shape** rule — a vendor prefix, a header line or an assignment whose left-hand
 *    side names a credential. Shape first is the whole anti-false-positive strategy (atlas tab 14
 *    "Risks"): entropy alone flags minified bundles, UUIDs and base64 blobs.
 *  - `group` is the capture group holding the secret itself (default: the whole match). Findings
 *    always report *that* span, so `masked`/`full` never carry the variable name around it and two
 *    rules that matched the same value are recognised as duplicates.
 *  - `entropyMin` is the second signal, in bits/char (`shannonEntropy`), applied to the captured
 *    value. It is only ever used where the shape is weak — a generic `secret = …` assignment, a
 *    JWT, an OpenAI-style `sk-…`, an AWS secret key. A vendor prefix with a fixed length and
 *    alphabet (`ghp_` + 36) needs no entropy check and gets none, so a planted documentation key
 *    such as `AKIAIOSFODNN7EXAMPLE` is still reported — it is a real key shape, and diffgit would
 *    rather say so than guess which `AKIA…` is a fixture.
 *
 * Order is precedence: the vendor rules come first and the generic assignment rules last, so when
 * two rules match the same span the scanner keeps the specific one (`dedupeMatches` in
 * `secrets.ts`).
 *
 * The rules ship with the release and never update themselves — `RULESET_DATE` is what the About
 * panel shows (atlas tab 14 "A rule set that never updates goes stale"). No rule here reads
 * anything; the module is pure data (D15: nothing is fetched, ever).
 */

export interface SecretRule {
  /** Stable id, reported as `SecretFinding.rule` and shown in the popover. */
  id: string;
  /** One line of human copy for the "Why flagged" row. */
  description: string;
  /** Sticky (`g`) matcher over one added line. */
  regex: RegExp;
  /** Capture group holding the secret (default 0 = the whole match). */
  group?: number;
  /** Shannon-entropy floor in bits/char for the captured value (second signal only). */
  entropyMin?: number;
}

/** The floor the atlas fixes for every entropy-gated rule (tab 14 "Risks"). */
export const ENTROPY_FLOOR = 3.8;

/** Left-hand sides that name a credential, for the generic assignment rules. */
const KEYWORD = {
  password: "(?:password|passwd|pwd)",
  secret: "(?:secret|client[_.-]?secret)",
  token: "(?:token|auth[_.-]?token|access[_.-]?token|bearer[_.-]?token)",
  apiKey: "(?:api[_.-]?key|apikey|access[_.-]?key|secret[_.-]?key|private[_.-]?key)",
} as const;

/** `name = "value"` / `name: value` with an optional quote, capturing the value. */
function assignment(keyword: string, min = 16): RegExp {
  return new RegExp(
    `[A-Za-z0-9_.-]*${keyword}[A-Za-z0-9_.-]*\\s*[:=]\\s*["'\`]?([^\\s"'\`,;)\\]}]{${min},})`,
    "gi",
  );
}

/**
 * The compiled rule set, in precedence order: cloud providers, source forges, SaaS tokens, private
 * key headers, then the weak generic shapes.
 */
export const SECRET_RULES: readonly SecretRule[] = [
  // ---- AWS -------------------------------------------------------------------------------------
  {
    id: "aws-access-key-id",
    description: "AWS access key id",
    regex: /\b((?:A3T[A-Z0-9]|AKIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA|ASIA)[A-Z0-9]{16})\b/g,
    group: 1,
  },
  {
    id: "aws-secret-access-key",
    description: "AWS secret access key",
    regex:
      /aws[_.-]?(?:secret|sec)[_.-]?(?:access[_.-]?)?key\s*[:=]\s*["'`]?([A-Za-z0-9/+=]{40})/gi,
    group: 1,
    entropyMin: ENTROPY_FLOOR,
  },
  {
    id: "aws-session-token",
    description: "AWS session token",
    regex: /aws[_.-]?session[_.-]?token\s*[:=]\s*["'`]?([A-Za-z0-9/+=]{100,})/gi,
    group: 1,
    entropyMin: ENTROPY_FLOOR,
  },
  {
    id: "aws-mws-auth-token",
    description: "Amazon MWS auth token",
    regex: /\b(amzn\.mws\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g,
    group: 1,
  },

  // ---- source forges ---------------------------------------------------------------------------
  {
    id: "github-personal-access-token",
    description: "GitHub personal access token (classic)",
    regex: /\b(ghp_[A-Za-z0-9]{36})\b/g,
    group: 1,
  },
  {
    id: "github-oauth-token",
    description: "GitHub OAuth access token",
    regex: /\b(gho_[A-Za-z0-9]{36})\b/g,
    group: 1,
  },
  {
    id: "github-user-to-server-token",
    description: "GitHub app user-to-server token",
    regex: /\b(ghu_[A-Za-z0-9]{36})\b/g,
    group: 1,
  },
  {
    id: "github-server-to-server-token",
    description: "GitHub app server-to-server token",
    regex: /\b(ghs_[A-Za-z0-9]{36})\b/g,
    group: 1,
  },
  {
    id: "github-refresh-token",
    description: "GitHub refresh token",
    regex: /\b(ghr_[A-Za-z0-9]{36})\b/g,
    group: 1,
  },
  {
    id: "github-fine-grained-token",
    description: "GitHub fine-grained personal access token",
    regex: /\b(github_pat_[A-Za-z0-9_]{60,})\b/g,
    group: 1,
  },
  {
    id: "gitlab-personal-access-token",
    description: "GitLab personal access token",
    regex: /\b(glpat-[A-Za-z0-9_-]{20,})/g,
    group: 1,
  },
  {
    id: "gitlab-pipeline-trigger-token",
    description: "GitLab pipeline trigger token",
    regex: /\b(glptt-[0-9a-f]{40})\b/g,
    group: 1,
  },
  {
    id: "gitlab-deploy-token",
    description: "GitLab deploy token",
    regex: /\b(gldt-[A-Za-z0-9_-]{20,})/g,
    group: 1,
  },
  {
    id: "gitlab-runner-registration-token",
    description: "GitLab runner registration token",
    regex: /\b(GR1348941[A-Za-z0-9_-]{20,})/g,
    group: 1,
  },
  {
    id: "bitbucket-app-password",
    description: "Bitbucket app password",
    regex: /bitbucket[_.-]?(?:app[_.-]?)?password\s*[:=]\s*["'`]?([A-Za-z0-9]{20,})/gi,
    group: 1,
    entropyMin: ENTROPY_FLOOR,
  },

  // ---- chat / collaboration --------------------------------------------------------------------
  {
    id: "slack-bot-token",
    description: "Slack bot token",
    regex: /\b(xoxb-[A-Za-z0-9-]{20,})/g,
    group: 1,
  },
  {
    id: "slack-user-token",
    description: "Slack user token",
    regex: /\b(xoxp-[A-Za-z0-9-]{20,})/g,
    group: 1,
  },
  {
    id: "slack-app-token",
    description: "Slack app-level token",
    regex: /\b(xoxa-[A-Za-z0-9-]{20,})/g,
    group: 1,
  },
  {
    id: "slack-webhook-url",
    description: "Slack incoming-webhook URL",
    regex:
      /(https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]{20,})/g,
    group: 1,
  },
  {
    id: "discord-bot-token",
    description: "Discord bot token",
    regex: /discord[_.-]?(?:bot[_.-]?)?token\s*[:=]\s*["'`]?([A-Za-z0-9_.-]{50,})/gi,
    group: 1,
    entropyMin: ENTROPY_FLOOR,
  },
  {
    id: "telegram-bot-token",
    description: "Telegram bot token",
    regex: /\b([0-9]{8,10}:AA[A-Za-z0-9_-]{33})\b/g,
    group: 1,
  },

  // ---- payments --------------------------------------------------------------------------------
  {
    id: "stripe-live-secret-key",
    description: "Stripe live secret key",
    regex: /\b(sk_live_[A-Za-z0-9]{24,})\b/g,
    group: 1,
  },
  {
    id: "stripe-live-restricted-key",
    description: "Stripe live restricted key",
    regex: /\b(rk_live_[A-Za-z0-9]{24,})\b/g,
    group: 1,
  },
  {
    id: "stripe-test-secret-key",
    description: "Stripe test secret key",
    regex: /\b(sk_test_[A-Za-z0-9]{24,})\b/g,
    group: 1,
  },
  {
    id: "stripe-webhook-secret",
    description: "Stripe webhook signing secret",
    regex: /\b(whsec_[A-Za-z0-9]{32,})\b/g,
    group: 1,
  },
  {
    id: "square-access-token",
    description: "Square access token",
    regex: /\b(sq0atp-[A-Za-z0-9_-]{22})\b/g,
    group: 1,
  },
  {
    id: "square-oauth-secret",
    description: "Square OAuth application secret",
    regex: /\b(sq0csp-[A-Za-z0-9_-]{43})\b/g,
    group: 1,
  },
  {
    id: "braintree-access-token",
    description: "Braintree production access token",
    regex: /\b(access_token\$production\$[0-9a-z]{16}\$[0-9a-f]{32})\b/g,
    group: 1,
  },
  {
    id: "paypal-client-secret",
    description: "PayPal client secret",
    regex: /paypal[_.-]?client[_.-]?secret\s*[:=]\s*["'`]?([A-Za-z0-9_-]{30,})/gi,
    group: 1,
    entropyMin: ENTROPY_FLOOR,
  },

  // ---- cloud / hosting -------------------------------------------------------------------------
  {
    id: "google-api-key",
    description: "Google API key",
    regex: /\b(AIza[A-Za-z0-9_-]{35})\b/g,
    group: 1,
  },
  {
    id: "google-oauth-client-secret",
    description: "Google OAuth client secret",
    regex: /\b(GOCSPX-[A-Za-z0-9_-]{28})\b/g,
    group: 1,
  },
  {
    id: "gcp-service-account-json",
    description: "Google service-account key file",
    regex: /"type"\s*:\s*"service_account"/g,
  },
  {
    id: "azure-storage-connection-string",
    description: "Azure storage account key",
    regex: /AccountKey\s*=\s*([A-Za-z0-9/+=]{64,})/g,
    group: 1,
    entropyMin: ENTROPY_FLOOR,
  },
  {
    id: "digitalocean-personal-access-token",
    description: "DigitalOcean personal access token",
    regex: /\b(dop_v1_[0-9a-f]{64})\b/g,
    group: 1,
  },
  {
    id: "heroku-api-key",
    description: "Heroku API key",
    regex:
      /heroku[_.-]?api[_.-]?key\s*[:=]\s*["'`]?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/gi,
    group: 1,
  },
  {
    id: "cloudflare-api-token",
    description: "Cloudflare API token",
    regex: /cloudflare[_.-]?api[_.-]?token\s*[:=]\s*["'`]?([A-Za-z0-9_-]{40})\b/gi,
    group: 1,
    entropyMin: ENTROPY_FLOOR,
  },
  {
    id: "vercel-token",
    description: "Vercel API token",
    regex: /vercel[_.-]?(?:api[_.-]?)?token\s*[:=]\s*["'`]?([A-Za-z0-9]{24,})\b/gi,
    group: 1,
    entropyMin: ENTROPY_FLOOR,
  },
  {
    id: "netlify-token",
    description: "Netlify access token",
    regex: /netlify[_.-]?(?:auth[_.-]?)?token\s*[:=]\s*["'`]?([A-Za-z0-9_-]{40,})/gi,
    group: 1,
    entropyMin: ENTROPY_FLOOR,
  },
  {
    id: "shopify-access-token",
    description: "Shopify access token",
    regex: /\b(shp(?:at|ca|pa|ss)_[0-9a-fA-F]{32})\b/g,
    group: 1,
  },
  {
    id: "atlassian-api-token",
    description: "Atlassian / Jira API token",
    regex: /\b(ATATT3[A-Za-z0-9_=-]{50,})/g,
    group: 1,
  },

  // ---- AI / model providers --------------------------------------------------------------------
  {
    id: "anthropic-api-key",
    description: "Anthropic API key",
    regex: /\b(sk-ant-(?:api|sid)[0-9]{2}-[A-Za-z0-9_-]{80,})/g,
    group: 1,
  },
  {
    id: "openai-project-key",
    description: "OpenAI project API key",
    regex: /\b(sk-proj-[A-Za-z0-9_-]{32,})/g,
    group: 1,
    entropyMin: ENTROPY_FLOOR,
  },
  {
    id: "openai-api-key",
    description: "OpenAI API key",
    regex: /\b(sk-[A-Za-z0-9]{32,})\b/g,
    group: 1,
    entropyMin: ENTROPY_FLOOR,
  },
  {
    id: "huggingface-access-token",
    description: "Hugging Face access token",
    regex: /\b(hf_[A-Za-z0-9]{34,})\b/g,
    group: 1,
  },

  // ---- messaging / mail / monitoring -----------------------------------------------------------
  {
    id: "twilio-account-sid",
    description: "Twilio account SID",
    regex: /\b(AC[0-9a-f]{32})\b/g,
    group: 1,
  },
  {
    id: "twilio-api-key-sid",
    description: "Twilio API key SID",
    regex: /\b(SK[0-9a-f]{32})\b/g,
    group: 1,
  },
  {
    id: "twilio-auth-token",
    description: "Twilio auth token",
    regex: /twilio[_.-]?(?:auth[_.-]?)?token\s*[:=]\s*["'`]?([0-9a-f]{32})\b/gi,
    group: 1,
  },
  {
    id: "sendgrid-api-key",
    description: "SendGrid API key",
    regex: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/g,
    group: 1,
  },
  {
    id: "mailgun-api-key",
    description: "Mailgun API key",
    regex: /\b(key-[0-9a-f]{32})\b/g,
    group: 1,
  },
  {
    id: "mailchimp-api-key",
    description: "Mailchimp API key",
    regex: /\b([0-9a-f]{32}-us[0-9]{1,2})\b/g,
    group: 1,
  },
  {
    id: "postmark-server-token",
    description: "Postmark server token",
    regex:
      /postmark[_.-]?(?:server[_.-]?)?token\s*[:=]\s*["'`]?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/gi,
    group: 1,
  },
  {
    id: "datadog-api-key",
    description: "Datadog API key",
    regex: /(?:datadog|dd)[_.-]?api[_.-]?key\s*[:=]\s*["'`]?([0-9a-f]{32})\b/gi,
    group: 1,
  },
  {
    id: "new-relic-license-key",
    description: "New Relic licence key",
    regex: /\b(NRAK-[A-Z0-9]{27})\b/g,
    group: 1,
  },
  {
    id: "sentry-dsn",
    description: "Sentry DSN with its secret",
    regex: /(https:\/\/[0-9a-f]{32}@[A-Za-z0-9.-]+\/[0-9]+)/g,
    group: 1,
  },
  {
    id: "linear-api-key",
    description: "Linear API key",
    regex: /\b(lin_api_[A-Za-z0-9]{40})\b/g,
    group: 1,
  },
  {
    id: "algolia-admin-key",
    description: "Algolia admin API key",
    regex: /algolia[_.-]?(?:admin[_.-]?)?(?:api[_.-]?)?key\s*[:=]\s*["'`]?([A-Za-z0-9]{32})\b/gi,
    group: 1,
    entropyMin: ENTROPY_FLOOR,
  },

  // ---- package registries ----------------------------------------------------------------------
  {
    id: "npm-access-token",
    description: "npm access token",
    regex: /\b(npm_[A-Za-z0-9]{36})\b/g,
    group: 1,
  },
  {
    id: "pypi-upload-token",
    description: "PyPI upload token",
    regex: /\b(pypi-[A-Za-z0-9_-]{50,})/g,
    group: 1,
  },
  {
    id: "rubygems-api-key",
    description: "RubyGems API key",
    regex: /\b(rubygems_[0-9a-f]{48})\b/g,
    group: 1,
  },
  {
    id: "docker-hub-personal-access-token",
    description: "Docker Hub personal access token",
    regex: /\b(dckr_pat_[A-Za-z0-9_-]{20,})/g,
    group: 1,
  },

  // ---- private keys ----------------------------------------------------------------------------
  {
    id: "private-key-rsa",
    description: "RSA private key header",
    regex: /-----BEGIN RSA PRIVATE KEY-----/g,
  },
  {
    id: "private-key-dsa",
    description: "DSA private key header",
    regex: /-----BEGIN DSA PRIVATE KEY-----/g,
  },
  {
    id: "private-key-ec",
    description: "EC private key header",
    regex: /-----BEGIN EC PRIVATE KEY-----/g,
  },
  {
    id: "private-key-openssh",
    description: "OpenSSH private key header",
    regex: /-----BEGIN OPENSSH PRIVATE KEY-----/g,
  },
  {
    id: "private-key-pgp",
    description: "PGP private key block header",
    regex: /-----BEGIN PGP PRIVATE KEY BLOCK-----/g,
  },
  {
    id: "private-key-pkcs8",
    description: "PKCS#8 private key header",
    regex: /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/g,
  },
  {
    id: "putty-private-key",
    description: "PuTTY private key header",
    regex: /PuTTY-User-Key-File-[0-9]+:/g,
  },

  // ---- weak shapes, entropy-gated --------------------------------------------------------------
  {
    id: "jwt",
    description: "JSON Web Token",
    regex: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
    group: 1,
    entropyMin: ENTROPY_FLOOR,
  },
  {
    id: "authorization-header",
    description: "Authorization header with a credential",
    regex: /authorization\s*[:=]\s*["'`]?(?:basic|bearer)\s+([A-Za-z0-9+/=_.-]{16,})/gi,
    group: 1,
    entropyMin: ENTROPY_FLOOR,
  },
  {
    id: "connection-string-credentials",
    description: "Connection string with an inline password",
    regex:
      /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|ftps?|https?):\/\/[^\s:@/]+:([^\s:@/]{8,})@[^\s/"'`]+/g,
    group: 1,
    entropyMin: ENTROPY_FLOOR,
  },
  {
    id: "generic-password-assignment",
    description: "Assignment to a password-like name",
    regex: assignment(KEYWORD.password),
    group: 1,
    entropyMin: ENTROPY_FLOOR,
  },
  {
    id: "generic-secret-assignment",
    description: "Assignment to a secret-like name",
    regex: assignment(KEYWORD.secret),
    group: 1,
    entropyMin: ENTROPY_FLOOR,
  },
  {
    id: "generic-token-assignment",
    description: "Assignment to a token-like name",
    regex: assignment(KEYWORD.token),
    group: 1,
    entropyMin: ENTROPY_FLOOR,
  },
  {
    id: "generic-api-key-assignment",
    description: "Assignment to an API-key-like name",
    regex: assignment(KEYWORD.apiKey),
    group: 1,
    entropyMin: ENTROPY_FLOOR,
  },
];

/**
 * The day this table was last reviewed, shown in the About panel (T11.9). Rules ship with the
 * release; nothing updates them over the network (D15).
 */
export const RULESET_DATE = "2026-09-19";

/** Inline escape hatch: a line ending in this comment is never reported. */
export const ALLOW_COMMENT = "diffgit:allow-secret";

/** Repo-root path allowlist, gitignore syntax (atlas tab 14 "If it is a fixture"). */
export const SECRET_ALLOWLIST_FILE = ".diffgitignore-secrets";

const ALLOW_COMMENT_RE = new RegExp(
  `(?:#|//|--|;|/\\*|<!--)[^\\n]*${ALLOW_COMMENT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:\\*/|-->)?\\s*$`,
);

/** True when the line carries a trailing `# diffgit:allow-secret` / `// diffgit:allow-secret`. */
export function hasAllowComment(line: string): boolean {
  return ALLOW_COMMENT_RE.test(line);
}

/**
 * Values that name a credential instead of being one: an environment lookup, a template
 * placeholder, an angle-bracket instruction. They are the commonest way a repository mentions a
 * secret without containing it, and several of them clear the entropy floor comfortably
 * (`process.env.API_KEY` is 3.93 bits/char).
 */
const REFERENCE = [
  /\$\{|\$\(|\{\{|%\(|<%|%%|#\{/, // ${VAR}, $(VAR), {{var}}, %(var)s, <%= %>, #{var}
  /^(?:process\.env|import\.meta\.env|os\.environ|System\.getenv|Deno\.env|ENV|env|config|settings|secrets|vault)\b[.[]/i,
  /^<[^>]*>$/, // <your-token-here>
];

/** True when the matched value is a reference to a secret rather than the secret itself. */
export function looksLikeReference(value: string): boolean {
  return REFERENCE.some((re) => re.test(value));
}

/**
 * A bare sha1 or sha256 digest. `release_commit = 9f2c…` is an object name, not a credential, and
 * a 40/64-hex string clears any entropy floor — so the scanner drops it outright.
 */
export function isHexDigest(value: string): boolean {
  return (value.length === 40 || value.length === 64) && /^[0-9a-fA-F]+$/.test(value);
}

/**
 * The redacted preview: first 8 characters, an ellipsis, last 4 — never the middle of the token
 * (atlas tab 14: "Findings are masked by default so a screen share does not leak them"). A value
 * too short for that to hide anything is replaced entirely.
 */
export function maskSecret(value: string): string {
  if (value.length <= 12) return "•".repeat(value.length);
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}
