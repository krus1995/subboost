import { encryptEncryptedFieldV2 } from "../../packages/server-core/src/crypto/encrypted-field.ts";

const encode = (value) => encryptEncryptedFieldV2(JSON.stringify(value), process.env.ENCRYPTION_KEY);
const urls = encode(["https://ci.invalid/subscription"]);
const nodes = encode([]);
const config = encode({ smartNodeMatchingEnabled: true });

// This database lives on the private check network and is removed on exit.
console.log(`
CREATE EXTENSION pgcrypto;
INSERT INTO "LocalAdmin" (id, username, "passwordHash", "updatedAt")
VALUES ('old-admin', 'ci-admin', crypt('upgrade-test-password', gen_salt('bf')), now());
INSERT INTO "Subscription" (id, "ownerId", name, token, "encryptedUrls", "encryptedNodes", "encryptedConfig", "updatedAt")
VALUES ('old-sub', 'old-admin', 'upgrade sample', 'sample-token', '${urls}', '${nodes}', '${config}', now());`);
