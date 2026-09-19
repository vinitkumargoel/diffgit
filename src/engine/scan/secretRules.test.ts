/**
 * T10.7: the rule table itself — one positive sample per rule, the near-misses that must stay
 * silent, the allow comment, the sha1/sha256 skip and the redaction.
 *
 * `SAMPLES` is exhaustive by assertion: a rule added to `SECRET_RULES` without a sample here fails
 * the "every rule has a sample" test, so the table can never grow untested.
 */
import { describe, expect, test } from "bun:test";
import {
  ALLOW_COMMENT,
  ENTROPY_FLOOR,
  hasAllowComment,
  isHexDigest,
  maskSecret,
  RULESET_DATE,
  SECRET_RULES,
} from "./secretRules";
import { scanLine } from "./secrets";

const FILE = { fileId: "f.txt", path: "f.txt", layer: "unstaged" } as const;

function rulesFor(text: string): string[] {
  return scanLine(FILE, { line: 1, text }).map((f) => f.rule);
}

/** A high-entropy filler of `n` characters, deterministic and alphabet-diverse. */
function noise(n: number, alphabet = "aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uVwXyZ"): string {
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[(i * 7 + 3) % alphabet.length];
  return out;
}

const HEX40 = "9f2c0a1b7d4e6c8a3b5d7f9e1c2a4b6d8e0f2a4c";
const HEX32 = "4ea38b7bf56377094bae87aea1234567";
const HEX64 = `${HEX40}${HEX32.slice(0, 24)}`;
const UUID = "3f7a1c2e-4b5d-4e6f-8a90-1b2c3d4e5f60";

/** One line per rule id that the rule must flag. */
const SAMPLES: Record<string, string> = {
  // AWS
  "aws-access-key-id": "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
  "aws-secret-access-key": "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "aws-session-token": `aws_session_token = "${noise(140, "aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uVwXyZ+/=")}"`,
  "aws-mws-auth-token": "token: amzn.mws.4ea38b7b-f563-7709-4bae-87aea1234567",
  // forges
  "github-personal-access-token": "github_token = ghp_0oP3xQz7LmT4vB9kY2wR6sN1dF8hJ5cA3eG0",
  "github-oauth-token": "gho_0oP3xQz7LmT4vB9kY2wR6sN1dF8hJ5cA3eG0",
  "github-user-to-server-token": "ghu_0oP3xQz7LmT4vB9kY2wR6sN1dF8hJ5cA3eG0",
  "github-server-to-server-token": "ghs_0oP3xQz7LmT4vB9kY2wR6sN1dF8hJ5cA3eG0",
  "github-refresh-token": "ghr_0oP3xQz7LmT4vB9kY2wR6sN1dF8hJ5cA3eG0",
  "github-fine-grained-token": `github_pat_${noise(62, "aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uVwXyZ_")}`,
  "gitlab-personal-access-token": `glpat-${noise(20)}`,
  "gitlab-pipeline-trigger-token": `glptt-${HEX40}`,
  "gitlab-deploy-token": `gldt-${noise(24)}`,
  "gitlab-runner-registration-token": `GR1348941${noise(22)}`,
  "bitbucket-app-password": "bitbucket_app_password = aB3dE5fG7hJ9kL1mN4pQ",
  // chat
  "slack-bot-token": "xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrSt",
  "slack-user-token": "xoxp-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrSt",
  "slack-app-token": "xoxa-2-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrSt",
  "slack-webhook-url":
    "https://hooks.slack.com/services/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",
  "discord-bot-token": `discord_bot_token = "${noise(60)}"`,
  "telegram-bot-token": `telegram = 123456789:AA${noise(33)}`,
  // payments
  "stripe-live-secret-key": `sk_live_${noise(26)}`,
  "stripe-live-restricted-key": `rk_live_${noise(26)}`,
  "stripe-test-secret-key": `sk_test_${noise(26)}`,
  "stripe-webhook-secret": `whsec_${noise(34)}`,
  "square-access-token": `sq0atp-${noise(22)}`,
  "square-oauth-secret": `sq0csp-${noise(43)}`,
  "braintree-access-token": `access_token$production$abcdef0123456789$${HEX32}`,
  "paypal-client-secret": `paypal_client_secret = "${noise(40)}"`,
  // cloud
  "google-api-key": `AIza${noise(35)}`,
  "google-oauth-client-secret": `GOCSPX-${noise(28)}`,
  "gcp-service-account-json": '  "type": "service_account",',
  "azure-storage-connection-string": `AccountKey=${noise(70, "aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uVwXyZ+/=")}`,
  "digitalocean-personal-access-token": `dop_v1_${HEX64}`,
  "heroku-api-key": `heroku_api_key = ${UUID}`,
  "cloudflare-api-token": `CLOUDFLARE_API_TOKEN=${noise(40)}`,
  "vercel-token": `VERCEL_TOKEN=${noise(26)}`,
  "netlify-token": `NETLIFY_AUTH_TOKEN=${noise(44)}`,
  "shopify-access-token": `shpat_${HEX32}`,
  "atlassian-api-token": `ATATT3${noise(60)}`,
  // AI providers
  "anthropic-api-key":
    "export ANTHROPIC_API_KEY=sk-ant-api03-7hQ2vLp9XcR4mZ0tK6yB3nW1dS8fA5gJ2eU7iO4rT9qY6xC3vN0bM8kH5lP2zD7wG4jF1sR6tY3uI9oA-QwErTyB",
  "openai-project-key": `sk-proj-${noise(40)}`,
  "openai-api-key": `sk-${noise(40, "aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uVwXyZ")}`,
  "huggingface-access-token": `hf_${noise(34, "aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uVwXyZ")}`,
  // messaging / mail / monitoring
  "twilio-account-sid": `AC${HEX32}`,
  "twilio-api-key-sid": `SK${HEX32}`,
  "twilio-auth-token": `twilio_auth_token = ${HEX32}`,
  "sendgrid-api-key": `SG.${noise(22)}.${noise(43)}`,
  "mailgun-api-key": `key-${HEX32}`,
  "mailchimp-api-key": `${HEX32}-us12`,
  "postmark-server-token": `postmark_server_token = ${UUID}`,
  "datadog-api-key": `DD_API_KEY=${HEX32}`,
  "new-relic-license-key": "NRAK-A1B2C3D4E5F6G7H8J9K0LMNPQRS",
  "sentry-dsn": `https://${HEX32}@o1234.ingest.sentry.io/5678`,
  "linear-api-key": `lin_api_${noise(40, "aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uVwXyZ")}`,
  "algolia-admin-key": `algolia_admin_api_key = ${noise(32, "aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uVwXyZ")}`,
  // registries
  "npm-access-token": `npm_${noise(36, "aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uVwXyZ")}`,
  "pypi-upload-token": `pypi-AgEIcHlwaS5vcmc${noise(40)}`,
  "rubygems-api-key": `rubygems_${HEX64.slice(0, 48)}`,
  "docker-hub-personal-access-token": `dckr_pat_${noise(24)}`,
  // private keys
  "private-key-rsa": "-----BEGIN RSA PRIVATE KEY-----",
  "private-key-dsa": "-----BEGIN DSA PRIVATE KEY-----",
  "private-key-ec": "-----BEGIN EC PRIVATE KEY-----",
  "private-key-openssh": "-----BEGIN OPENSSH PRIVATE KEY-----",
  "private-key-pgp": "-----BEGIN PGP PRIVATE KEY BLOCK-----",
  "private-key-pkcs8": "-----BEGIN ENCRYPTED PRIVATE KEY-----",
  "putty-private-key": "PuTTY-User-Key-File-2: ssh-rsa",
  // weak shapes
  jwt: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFkYSJ9.${noise(43)}`,
  "authorization-header": `Authorization: Bearer ${noise(40)}`,
  "connection-string-credentials": `postgres://app:${noise(24)}@db.internal:5432/app`,
  "generic-password-assignment": `db_password = "${noise(24)}"`,
  "generic-secret-assignment": `SESSION_SECRET=${noise(24)}`,
  "generic-token-assignment": `slack_token: ${noise(24)}`,
  "generic-api-key-assignment": `service_api_key = "${noise(24)}"`,
};

describe("secret rule table", () => {
  test("every rule has a sample, and no sample is shared", () => {
    const ids = SECRET_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // ids are unique
    expect(Object.keys(SAMPLES).sort()).toEqual([...ids].sort());
    expect(ids.length).toBeGreaterThanOrEqual(60); // the brief asks for ≈ 60 rules
  });

  test("every entropy-gated rule uses the documented 3.8 bits/char floor", () => {
    for (const rule of SECRET_RULES) {
      if (rule.entropyMin !== undefined) expect(rule.entropyMin).toBe(ENTROPY_FLOOR);
    }
  });

  test("every rule has a description and a global regex", () => {
    for (const rule of SECRET_RULES) {
      expect(rule.description.length).toBeGreaterThan(3);
      expect(rule.regex.global).toBe(true);
    }
  });

  for (const [id, line] of Object.entries(SAMPLES)) {
    test(`${id}: flags its sample exactly once`, () => {
      expect(rulesFor(line)).toEqual([id]);
    });
  }

  test("RULESET_DATE is an ISO date (the About panel shows it)", () => {
    expect(RULESET_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("near-misses stay silent", () => {
  const QUIET = [
    // a prefix of the right shape but the wrong length
    "token = ghp_tooshort",
    "key = AKIA",
    "id = AKIAIOSFODNN7EXAMP", // 15 body characters, not 16
    // an object name, not a credential (the `secrets` fixture plants this line)
    `release_commit = ${HEX40}`,
    // a sha1 / sha256 under a credential-shaped name: the digest skip, not the entropy floor
    `api_secret = ${HEX40}`,
    `secret_key = ${HEX64}`,
    // placeholders and indirection
    'password = "changeme"',
    'password = "xxxxxxxxxxxxxxxxxxxx"',
    `github_token = \${GITHUB_TOKEN}`,
    "api_key = process.env.API_KEY",
    "api_key = import.meta.env.VITE_API_KEY",
    'password = os.environ["DB_PASSWORD"]',
    "secret = config.secrets.sessionSecret",
    'token = "{{ vault_github_token }}"',
    "password = <your-password-here-goes>",
    'secret = ""',
    // the body of a PEM block: only the header is a rule
    "MIIBOgIBAAJBAJ9y7hQ2vLp9XcR4mZ0tK6yB3nW1dS8fA5gJ2eU7iO4rT9qY6xC3",
    "vN0bM8kH5lP2zD7wG4jF1sR6tY3uI9oAQwErTyBhZ0kCAwEAAQJATl1vZmFrZWtl",
    // ordinary code that names credentials
    "const authToken = useAuth();",
    "export function getSecret(name: string): string | null {",
    "// TODO: read the api key from the environment",
    '<input type="password" name="password" autocomplete="current-password" />',
    // a public key header is not a private key
    "-----BEGIN PUBLIC KEY-----",
    "-----BEGIN CERTIFICATE-----",
    // a UUID is not a token
    `request_id = ${UUID}`,
  ];
  for (const line of QUIET) {
    test(`no finding: ${line.slice(0, 48)}`, () => {
      expect(rulesFor(line)).toEqual([]);
    });
  }

  test("a documentation AWS key is still reported (it is a real key shape)", () => {
    // The atlas asks for prefix rules first and entropy only as a second signal; `AKIA…EXAMPLE`
    // has a fixed, unambiguous shape, so diffgit reports it rather than guessing which AKIA is a
    // fixture. `# diffgit:allow-secret` and `.diffgitignore-secrets` are the escape hatches.
    expect(rulesFor("aws_access_key_id = AKIAIOSFODNN7EXAMPLE")).toEqual(["aws-access-key-id"]);
  });
});

describe("allow comment", () => {
  const TOKEN = "ghp_1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2wX";
  test("recognises the shell, C, SQL and XML comment spellings", () => {
    expect(hasAllowComment(`legacy_token = ${TOKEN} # ${ALLOW_COMMENT}`)).toBe(true);
    expect(hasAllowComment(`const t = "${TOKEN}"; // ${ALLOW_COMMENT}`)).toBe(true);
    expect(hasAllowComment(`select '${TOKEN}' -- ${ALLOW_COMMENT}`)).toBe(true);
    expect(hasAllowComment(`<t>${TOKEN}</t> <!-- ${ALLOW_COMMENT} -->`)).toBe(true);
    expect(hasAllowComment(`t = "${TOKEN}" /* ${ALLOW_COMMENT} */`)).toBe(true);
  });
  test("only at the end of the line, and only as a comment", () => {
    expect(hasAllowComment(`# ${ALLOW_COMMENT} applies below`)).toBe(false);
    expect(hasAllowComment(`token = ${ALLOW_COMMENT}`)).toBe(false);
  });
  test("an allowlisted line yields no findings at all", () => {
    expect(rulesFor(`legacy_token = ${TOKEN} # ${ALLOW_COMMENT}`)).toEqual([]);
    expect(rulesFor(`legacy_token = ${TOKEN}`)).toEqual(["github-personal-access-token"]);
  });
});

describe("isHexDigest", () => {
  test("exactly 40 or 64 hex characters", () => {
    expect(isHexDigest(HEX40)).toBe(true);
    expect(isHexDigest(HEX64)).toBe(true);
    expect(isHexDigest(HEX40.toUpperCase())).toBe(true);
    expect(isHexDigest(HEX32)).toBe(false); // 32: an md5, and also Twilio/Datadog key shapes
    expect(isHexDigest(`${HEX40}a`)).toBe(false);
    expect(isHexDigest(HEX40.replace("f", "z"))).toBe(false);
  });
});

describe("maskSecret", () => {
  const TOKEN = "ghp_0oP3xQz7LmT4vB9kY2wR6sN1dF8hJ5cA3eG0";
  test("first 8, an ellipsis, last 4 — never the middle", () => {
    const masked = maskSecret(TOKEN);
    expect(masked).toBe("ghp_0oP3…3eG0");
    expect(masked).not.toContain(TOKEN.slice(8, -4));
    for (let i = 8; i + 5 <= TOKEN.length - 4; i++) {
      expect(masked).not.toContain(TOKEN.slice(i, i + 5));
    }
  });
  test("a short value is replaced entirely rather than half-revealed", () => {
    expect(maskSecret("abcdefghijkl")).toBe("•".repeat(12));
    expect(maskSecret("abc")).toBe("•••");
    expect(maskSecret("")).toBe("");
  });
  test("the finding's masked preview hides the middle of every sample", () => {
    for (const line of Object.values(SAMPLES)) {
      for (const f of scanLine(FILE, { line: 1, text: line })) {
        if (f.full.length <= 12) {
          expect(f.masked).toBe("•".repeat(f.full.length));
          continue;
        }
        expect(f.masked).toBe(`${f.full.slice(0, 8)}…${f.full.slice(-4)}`);
        expect(f.masked).not.toContain(f.full.slice(8, -4));
      }
    }
  });
});
