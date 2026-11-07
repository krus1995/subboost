#!/usr/bin/env python3
"""Run on Linux as root, against a disposable PostgreSQL 16 container. No production configuration is read."""
import contextlib
import io
import hashlib
import tarfile
import json
import os
import secrets
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from unittest.mock import Mock, patch

import host
import image_identity
from production import Site, run
from smoke import CheckError


def checked_error(fn):
    try:
        fn()
    except CheckError:
        return
    raise AssertionError("expected rejection")


def invoke(*args):
    with contextlib.redirect_stdout(io.StringIO()) as out:
        host.command(list(args))
    return json.loads(out.getvalue()) if out.getvalue() else None


def receiver(root):
    host.BASE = base = root / "state"
    host.INCOMING = incoming = base / "incoming"
    host.RECORDS = base / "receipts"
    host.CONFIG = cfg = root / "host.json"
    for p in (base, incoming, host.RECORDS):
        p.mkdir()
    env_file = root / ".env"
    compose = root / "compose.json"
    session = root / "session.json"
    for p in (env_file, compose, session, root / "backup.key"):
        p.write_text(secrets.token_hex(32))
    cfg.write_text(json.dumps({"project": "testing", "projectDir": str(root), "composeFiles": [str(compose)],
                              "envFile": str(env_file), "businessCredentials": str(session), "dbUser": "postgres",
                              "database": "subboost", "dbNetwork": "testnet", "candidatePort": 3109,
                              "localUrl": "http://127.0.0.1:3108"}))
    sha, image, transfer = "a"*40, "sha256:" + "b"*64, "1-1"
    payload = b"an immutable isolated test archive"
    import hashlib
    archive = hashlib.sha256(payload).hexdigest()
    assert invoke("status", sha)["phase"] == "ABSENT"
    args = ("prepare", sha, transfer, str(len(payload)), archive, image)
    assert invoke(*args) == {"upload": True, "deployPath": str(root)}
    partial = incoming / (sha + "." + transfer + ".partial")
    (partial / "image.tar.gz").write_bytes(payload)
    manifest = {"sourceSha": sha, "imageId": image, "archiveSha256": archive, "schemaVersion": 1,
                "repository": host.REPO, "platform": "linux/amd64", "imageReference": "subboost-fork:" + sha,
                "upstreamTag": "v2.11.0", "upstreamCommit": "c"*40, "migrationTreeSha256": "0"*64,
                "workflowRunUrl": "https://github.com/krus1995/subboost/actions/runs/1"}
    (partial / "release.json").write_text(json.dumps(manifest))
    (partial / "SHA256SUMS").write_text(archive + "  image.tar.gz\n" + host.digest(partial / "release.json") + "  release.json\n")
    (partial / "image.tar.gz").write_bytes(b"bad")
    checked_error(lambda: invoke("submit", sha, transfer, archive, image))
    assert invoke("status", sha)["phase"] == "ABSENT"
    (partial / "image.tar.gz").write_bytes(payload)
    with patch.object(host, "main_sha", return_value="d"*40):
        invoke("submit", sha, transfer, archive, image)
    assert invoke("status", sha)["phase"] == "SUPERSEDED"
    assert invoke(*args)["upload"] is False
    checked_error(lambda: invoke("prepare", sha, "1-2", "100", "f"*64, image))
    host_image = "sha256:" + "c"*64
    host.update(sha, "ACTIVE", productionImageId=host_image)
    with patch.object(host, "main_sha", return_value=sha), patch.object(Site, "assert_active") as health:
        invoke("submit", sha, transfer, archive, image)
        health.assert_called_once_with(host_image)
    print("Receiver: real prepare, status, damaged archive, stale SHA, conflicting identity and idempotent submit passed.")


def image_stores(root):
    sha = "a"*40
    tag = "subboost-fork:" + sha
    files = {}
    def blob(data, media):
        data = json.dumps(data).encode() if isinstance(data, dict) else data
        digest = hashlib.sha256(data).hexdigest()
        files["blobs/sha256/" + digest] = data
        return {"digest": "sha256:" + digest, "size": len(data), "mediaType": media}

    labels = {"org.opencontainers.image.revision": sha, "org.opencontainers.image.source": "https://github.com/krus1995/subboost"}
    env = ["APP_BUILD_SHA=" + sha]
    layer = blob(b"synthesized image layer", image_identity.OCI + "layer.v1.tar")
    cfg = blob({"architecture": "amd64", "os": "linux", "config": {"Labels": labels, "Env": env},
                "rootfs": {"type": "layers", "diff_ids": [layer["digest"]]}}, image_identity.CONFIG_TYPES[0])
    desc = blob({"schemaVersion": 2, "mediaType": image_identity.MANIFEST_TYPES[0], "config": cfg, "layers": [layer]},
                image_identity.MANIFEST_TYPES[0])
    desc["annotations"] = {"org.opencontainers.image.ref.name": sha, "io.containerd.image.name": "docker.io/library/" + tag}
    files["oci-layout"] = b'{"imageLayoutVersion":"1.0.0"}'
    files["index.json"] = json.dumps({"schemaVersion": 2, "manifests": [desc]}).encode()
    files["manifest.json"] = json.dumps([{"Config": "blobs/sha256/" + cfg["digest"][7:], "RepoTags": [tag],
                                          "Layers": ["blobs/sha256/" + layer["digest"][7:]]}]).encode()
    path = root / "graph.tar.gz"
    def save():
        with tarfile.open(path, "w:gz") as tar:
            for name, data in files.items():
                item = tarfile.TarInfo(name)
                item.size = len(data)
                tar.addfile(item, io.BytesIO(data))
    save()
    release = {"sourceSha": sha, "imageReference": tag, "schemaVersion": 2, "imageId": cfg["digest"],
               "configDigest": cfg["digest"], "manifestDigest": desc["digest"], "migrationTreeSha256": "0"*64}
    foreign = "sha256:" + "f"*64
    for build in (cfg["digest"], desc["digest"]):
        for local_id in (cfg["digest"], desc["digest"]):
            inspect = [{"Id": local_id, "Architecture": "amd64", "Os": "linux", "Config": {"Labels": labels, "Env": env}}]
            with patch("production.subprocess.run", return_value=Mock(returncode=0)), patch("production.run",
                       side_effect=[json.dumps(inspect).encode(), b"0"*64]) as docker:
                assert Site.image(None, {**release, "imageId": build}, path) == local_id
                assert local_id in docker.call_args.args[0]
    for key in ("configDigest", "manifestDigest", "imageId"):
        checked_error(lambda: image_identity.verify_release_graph(path, {**release, key: foreign}))
    with patch("production.subprocess.run", return_value=Mock(returncode=0)), patch("production.run",
               return_value=json.dumps([{"Id": foreign}]).encode()):
        checked_error(lambda: Site.image(None, release, path))
    files["blobs/sha256/" + cfg["digest"][7:]] += b" "
    save()
    checked_error(lambda: image_identity.verify_release_graph(path, release))
    print("Image identity: both Docker stores, forged build/local/manifest/config IDs and modified blob checked.")


def phase_boundaries():
    # Fail the candidate and final smoke separately; the actual DB replacement is exercised below.
    for fail_at in ("candidate", "activation"):
        site = Mock(spec=Site)
        site.old_image = "sha256:" + "0"*64
        site.image.return_value = "verified-host-id"
        site.base = host.BASE
        (host.BASE / "backups").mkdir(exist_ok=True)
        site.appid, site.cronid = "old-app", "cron"
        site.db, site.prod_oid = "subboost", 123
        site.appenv = {"DATABASE_URL": "fake"}
        site.db_meta.return_value = {"oid": 123}
        site.backup.return_value = {}
        site.session = ("x", "y")
        if fail_at == "candidate":
            site.start_candidate.side_effect = [None, CheckError("candidate migration failed")]
        else:
            site.set_image.side_effect = CheckError("activation failed")
        phases = []
        with patch("production.run"), patch("production.container", return_value={"State": {"Running": False}}):
            checked_error(lambda: Site.deploy(site, {"sourceSha": "1"*40, "imageId": "new", "imageReference": "ref"},
                                              host.BASE, lambda phase, **kw: phases.append(phase), lambda: True))
        if fail_at == "candidate":
            assert site.start_candidate.call_args.args[0] == "verified-host-id"
            site.rollback.assert_called_once()
            site.start_original.assert_called_once()
            assert phases[-1] == "FAILED"
        else:
            site.rollback.assert_not_called()
            site.start_original.assert_not_called()
            assert phases[-1] == "ACTIVATING"
    print("Release phase tests: candidate recovery and post-activation data preservation passed.")


def postgres(root, engine):
    # Production calls use docker. Only this test routes them to the selected local engine.
    site = Site(host.CONFIG, host.BASE)
    token = secrets.token_hex(10)
    cid = run([engine, "run", "--rm", "-d", "--network", "none", "-e", "POSTGRES_PASSWORD=" + token,
               "-e", "POSTGRES_DB=subboost", "docker.io/library/postgres:16-alpine"]).decode().strip()
    try:
        site.dbid = cid
        site.dbcmd = lambda *args: [engine, "exec", "-i", cid, *args]
        for _ in range(60):
            if subprocess.run(site.dbcmd("pg_isready", "-h", "127.0.0.1", "-U", "postgres"),
                              capture_output=True).returncode == 0:
                break
            time.sleep(1)
        site.old_image = "isolated"
        site.candidate_id = ""
        site.snapshot = root / "snapshot"
        site.snapshot.mkdir()
        site.prod_oid = site.db_meta(site.db)["oid"]
        site.sql(site.db, 'CREATE TABLE "LocalAdmin"(id text primary key);'
                 'CREATE TABLE "LocalTemplate"(id text); CREATE TABLE "Subscription"(id text, "ownerId" text '
                 'REFERENCES "LocalAdmin"(id)); CREATE TABLE _prisma_migrations(migration_name text, checksum text, '
                 'finished_at timestamp); INSERT INTO "LocalAdmin" VALUES (\'owner\'); '
                 'INSERT INTO "Subscription" VALUES (\'kept\',\'owner\');')
        info = site.backup()
        assert info["dbSha256"] and info["configSha256"]
        checked_error(lambda: site.sql(site.db, 'CREATE TABLE introduced_by_bad_migration(id int); COMMIT; SELECT 1 / 0;'))
        assert site.sql(site.db, "SELECT to_regclass('introduced_by_bad_migration')") == "introduced_by_bad_migration"
        site.rollback()
        assert site.sql(site.db, "SELECT to_regclass('introduced_by_bad_migration') IS NULL") == "t"
        assert site.sql(site.db, 'SELECT id FROM "Subscription"') == "kept"
        print("PostgreSQL 16: encrypted custom dump restored into empty DB; original row survived and failed migration table disappeared.")
    finally:
        run([engine, "rm", "-fv", cid])


if __name__ == "__main__":
    assert os.geteuid() == 0
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="subboost-host-test-") as tmp:
        root = Path(tmp)
        receiver(root)
        image_stores(root)
        phase_boundaries()
        postgres(root, os.environ.get("CONTAINER_ENGINE", "docker"))
