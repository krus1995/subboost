-- Synthetic subscription encrypted by SubBoost v2.11.0 with the public
-- test key in check-image.sh. Keep these ciphertexts when testing later versions.
CREATE EXTENSION pgcrypto;
INSERT INTO "LocalAdmin" (id, username, "passwordHash", "updatedAt")
VALUES ('old-admin', 'ci-admin', crypt('upgrade-test-password', gen_salt('bf')), now());
INSERT INTO "Subscription" (id, "ownerId", name, token, "encryptedUrls", "encryptedNodes", "encryptedConfig", "updatedAt")
VALUES (
  'old-sub', 'old-admin', 'upgrade sample', 'sample-token',
  'v2:7f167bd066dc01965bc1a121:7a9a6186066911c910fd09e4c97f24d3:678f1fea0ba3b9814540d587eb7fbc0ff599006e7a2de777d730160a4ce4341462d53b',
  'v2:28c74eef19c6e7041494d33d:30955b87c0398d5aa86ec5351c077cfd:dec9',
  'v2:ba334797d27c95bfb888badd:e957e979aacd44ae054cd9e9683955d5:b86b5cd9077aaee874f64ea22428db8337f1800b70d4f810b1eac8ac309b85e81a',
  now()
);
