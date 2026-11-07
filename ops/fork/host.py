#!/usr/bin/env python3
"""Root-owned release receiver for the single SubBoost fork."""
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

# -I excludes the script's directory from sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from production import Site
from smoke import CheckError, require

BASE = Path("/var/lib/subboost-fork")
INCOMING = BASE / "incoming"
RECORDS = BASE / "receipts"
CONFIG = Path("/etc/subboost-fork/host.json")
SELF = "/usr/local/sbin/subboost-fork-deploy"
REPO = "krus1995/subboost"
SHA = r"[0-9a-f]{40}"
DIGEST = r"[0-9a-f]{64}"
FILES = {"image.tar.gz", "release.json", "SHA256SUMS"}
TERMINAL = {"ABSENT", "ACTIVE", "SUPERSEDED", "FAILED"}


def valid(pattern, value):
    require(isinstance(value, str) and re.fullmatch(pattern, value), "invalid identifier")
    return value


def owned(path, directory=False, private=False):
    s = path.lstat()
    require(path.absolute() == path.resolve() and s.st_uid == 0 and
            not s.st_mode & (0o077 if private else 0o022) and
            (stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode) and s.st_nlink == 1),
            "unsafe owner, path or permissions")


def dump(path, record):
    encoded = (json.dumps(record, sort_keys=True) + "\n").encode()
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
        output.write(encoded)
        output.flush()
        os.fsync(output.fileno())
    os.replace(output.name, path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def record(sha):
    path = RECORDS / (sha + ".json")
    if not path.exists():
        return {"phase": "ABSENT", "sourceSha": sha}
    owned(path, private=True)
    return json.loads(path.read_bytes())


def update(sha, phase, **data):
    r = record(sha)
    r.update(phase=phase, updated=datetime.datetime.now(datetime.timezone.utc).isoformat(), **data)
    if phase == "ACTIVE":
        r.setdefault("activated", r["updated"])
    dump(RECORDS / (sha + ".json"), r)
    return r


def digest(path):
    with path.open("rb") as f:
        h = hashlib.sha256()
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
        return h.hexdigest()


def verify(directory, sha, archive, image):
    owned(directory, directory=True, private=True)
    require({x.name for x in directory.iterdir()} == FILES, "unexpected release contents")
    for name in FILES:
        owned(directory / name)
    m = json.loads((directory / "release.json").read_bytes())
    require(m["repository"] == REPO and m["schemaVersion"] == 1 and m["sourceSha"] == sha and
            m["platform"] == "linux/amd64" and m["imageReference"] == "subboost-fork:" + sha and
            m["imageId"] == image and m["archiveSha256"] == archive, "release identity mismatch")
    valid(SHA, m["upstreamCommit"])
    valid(DIGEST, m["migrationTreeSha256"])
    valid(r"https://github\.com/krus1995/subboost/actions/runs/[0-9]+(?:/attempts/[0-9]+)?", m["workflowRunUrl"])
    require(m["upstreamTag"] and digest(directory / "image.tar.gz") == archive, "archive hash mismatch")
    expected = [archive + "  image.tar.gz", digest(directory / "release.json") + "  release.json"]
    require((directory / "SHA256SUMS").read_text().splitlines() == expected, "checksum file mismatch")
    return m


@contextlib.contextmanager
def gate(name):
    with (BASE / name).open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def main_sha():
    request = urllib.request.Request("https://api.github.com/repos/" + REPO + "/git/ref/heads/main",
                                     headers={"User-Agent": "subboost-fork-deploy", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(request, timeout=12) as response:
        return valid(SHA, json.load(response)["object"]["sha"])


def running(sha):
    unit = record(sha).get("unit")
    if not unit:
        return False
    result = subprocess.run(["systemctl", "show", "-p", "ActiveState", "--value", unit],
                            capture_output=True, check=False)
    return result.stdout.strip() in {b"active", b"activating", b"reloading", b"deactivating"}


def check_stale(sha):
    r = record(sha)
    if r["phase"] not in TERMINAL and not running(sha):
        if r["phase"] == "QUEUED":
            return update(sha, "FAILED", retrySafe=True, error="worker stopped before maintenance")
        return update(sha, "FAILED", interruptedAt=r["phase"], error="worker stopped; inspect before retry")
    return r


def conflicts(sha, archive, image):
    r = record(sha)
    if r.get("imageId", image) != image or r.get("archiveSha256", archive) != archive:
        dump(RECORDS / (sha + ".conflict.json"), {"sourceSha": sha, "archiveSha256": archive, "imageId": image})
        raise CheckError("different artifact already registered for this SHA")


def job(sha):
    with gate("deploy.lock"):
        r = record(sha)
        require(r["phase"] == "QUEUED", "worker is not queued")
        try:
            if main_sha() != sha:
                update(sha, "SUPERSEDED")
                return
            m = verify(INCOMING / sha, sha, r["archiveSha256"], r["imageId"])
            site = Site(CONFIG, BASE)
            site.deploy(m, INCOMING / sha, lambda phase, **kw: update(sha, phase, **kw),
                        lambda: main_sha() == sha)
            if record(sha)["phase"] == "ACTIVE":
                dump(BASE / "current.json", record(sha))
                try:
                    prune_successes()
                except (CheckError, OSError, ValueError, KeyError):
                    update(sha, "ACTIVE", cleanupPending=True)
        except BaseException as error:
            previous = record(sha)["phase"]
            if previous == "FAILED":
                update(sha, "FAILED", error=str(error) if isinstance(error, CheckError) else type(error).__name__)
                raise
            reason = str(error) if isinstance(error, CheckError) else type(error).__name__
            update(sha, "FAILED", failedAt=previous, error=reason,
                   retrySafe=previous in ("PREPARED", "QUEUED") and not record(sha).get("recoveryRequired"))
            raise


def prune_successes():
    successes = sorted((json.loads(p.read_bytes()) for p in RECORDS.glob("*.json")
                        if re.fullmatch(SHA + r"\.json", p.name)),
                       key=lambda r: r.get("activated", r["updated"]), reverse=True)
    for r in successes:
        if r["phase"] == "SUPERSEDED" and not r.get("activated"):
            sha = valid(SHA, r["sourceSha"])
            archive = INCOMING / sha
            if archive.is_dir():
                verify(archive, sha, r["archiveSha256"], r["imageId"])
                shutil.rmtree(archive)
    successes = [r for r in successes if r["phase"] == "ACTIVE" or r.get("activated")]
    for position, r in enumerate(successes):
        sha = valid(SHA, r["sourceSha"])
        path = INCOMING / sha
        if position >= 2 and path.is_dir():
            verify(path, sha, r["archiveSha256"], r["imageId"])
            shutil.rmtree(path)
            # docker rmi without -f refuses a last tag of an image used by a container.
            for tag in ("subboost-fork:" + sha, "subboost-previous:" + r["imageId"].removeprefix("sha256:")):
                image = subprocess.run(["docker", "image", "inspect", "-f", "{{.Id}}", tag], capture_output=True)
                if image.returncode == 0 and image.stdout.decode().strip() == r["imageId"]:
                    subprocess.run(["docker", "image", "rm", tag], stdout=subprocess.DEVNULL, check=False)
        if position >= 10:
            path = Path(r["backup"])
            if path.exists():
                owned(path, directory=True, private=True)
                require(path.parent == BASE / "backups" and re.fullmatch(sha + "-[a-f0-9]{10}", path.name)
                        and (path / "backup.json").is_file(), "backup retention identity mismatch")
                shutil.rmtree(path)


def prune_partials(current):
    # In-progress transfers get their own staging directory. Only abandoned ones expire.
    import time
    for path in INCOMING.iterdir():
        if (path != current and re.fullmatch(SHA + r"\.[0-9]+-[0-9]+\.partial", path.name)
                and time.time() - path.stat().st_mtime > 7 * 86400):
            owned(path, directory=True, private=True)
            require(all(f.name in FILES for f in path.iterdir()), "unexpected staging contents")
            for f in path.iterdir():
                owned(f)
            shutil.rmtree(path)


def command(args):
    require(os.geteuid() == 0, "root required")
    os.umask(0o077)
    for path in (BASE, INCOMING, RECORDS):
        owned(path, directory=True, private=True)
    op, *args = args
    if op == "preflight" and not args:
        site = Site(CONFIG, BASE)
        print(json.dumps(site.preflight(readonly=True)))
        return
    if op == "retry-current" and not args:
        sha = main_sha()
        receipt = record(sha)
        require(receipt.get("imageId") and (INCOMING / sha).is_dir(),
                "use the fork deployment workflow to deliver the verified current main artifact")
        transfer = str(int(datetime.datetime.now().timestamp())) + "-1"
        return command(["submit", sha, transfer, receipt["archiveSha256"], receipt["imageId"]])
    if op in ("rehearse", "backup", "logs") and not args:
        site = Site(CONFIG, BASE)
        if op == "logs":
            os.execvp("docker", site.compose + ["logs", "--tail", "60", "-f", "app", "cron"])
        with gate("deploy.lock"):
            if op == "rehearse":
                result = site.rehearsal()
                dump(BASE / "rehearsal.json", result)
            else:
                site.preflight(readonly=True)
                site.snapshot = BASE / "backups" / ("manual-" + os.urandom(10).hex())
                site.snapshot.mkdir(mode=0o700)
                result = site.backup_files()
                dump(site.snapshot / "backup.json", result)
            print(json.dumps(result))
        return
    sha = valid(SHA, args[0])
    if op == "worker" and len(args) == 1:
        job(sha)
        return
    with gate("requests.lock"):
        if op == "reconcile" and len(args) == 1:
            # Recovery is an explicit host operation. It performs no database writes or image switches.
            with gate("deploy.lock"):
                r = record(sha)
                require(r["phase"] == "FAILED" and (r.get("recoveryRequired") or r.get("interruptedAt")),
                        "no interrupted release to reconcile")
                site = Site(CONFIG, BASE)
                site.preflight()
                from smoke import check_site, PUBLIC
                check_site(PUBLIC, site.session)
                actual = site.old_image
                require(actual in (r.get("oldImageId"), r.get("imageId")), "unexpected active image")
                require(not any(n.startswith("subboost-candidate-") for n in
                                subprocess.check_output(["docker", "ps", "--format", "{{.Names}}"]).decode().splitlines()),
                        "a candidate or reservation is still running")
                if actual == r.get("imageId"):
                    require(r.get("everActivated") or r.get("interruptedAt") == "ACTIVATING",
                            "candidate was never activated; inspect the deployment identity")
                    result = update(sha, "ACTIVE", interruptedAt=None, recoveryRequired=False, reconciled=True)
                    dump(BASE / "current.json", result)
                else:
                    site.verify_old_recovery(r)
                    result = update(sha, "FAILED", interruptedAt=None, recoveryRequired=False, retrySafe=True, reconciled=True)
                print(json.dumps(result))
                return
        if op == "status" and len(args) == 1:
            print(json.dumps(check_stale(sha)))
            return
        require((op == "prepare" and len(args) == 5) or (op == "submit" and len(args) == 4), "usage error")
        transfer = valid(r"[0-9]{1,24}-[0-9]{1,10}", args[1])
        archive = valid(DIGEST, args[-2])
        image = valid("sha256:" + DIGEST, args[-1])
        conflicts(sha, archive, image)
        partial = INCOMING / (sha + "." + transfer + ".partial")
        final = INCOMING / sha
        if op == "prepare":
            size = int(valid(r"[1-9][0-9]{0,12}", args[2]))
            require(shutil.disk_usage(INCOMING).free > size * (1 if final.exists() else 2) + 64 * 1024**2, "incoming space low")
            prune_partials(partial)
            if final.exists():
                verify(final, sha, archive, image)
            else:
                partial.mkdir(exist_ok=True, mode=0o700)
                owned(partial, directory=True, private=True)
                for item in partial.iterdir():
                    require(item.name in FILES, "unexpected partial file")
                    owned(item)
            print(json.dumps({"upload": not final.exists(), "deployPath": str(Site(CONFIG, BASE).root)}))
            return
        inflight = BASE / "inflight.json"
        if inflight.exists():
            active = valid(SHA, json.loads(inflight.read_bytes())["sourceSha"])
            pending = check_stale(active)
            if pending["phase"] not in TERMINAL:
                if sha == active:
                    print(json.dumps(pending))
                    return
                print(json.dumps({"busy": active}))
                raise SystemExit(75)
            # Operators must reconcile an interrupted maintenance window before a new release.
            require(not pending.get("interruptedAt") and not pending.get("recoveryRequired"), "last release needs reconciliation")
        if partial.exists():
            verify(partial, sha, archive, image)
            if not final.exists():
                partial.rename(final)
        verify(final, sha, archive, image)
        r = record(sha)
        if r["phase"] == "ACTIVE" and main_sha() == sha:
            Site(CONFIG, BASE).assert_active(image)
            print(json.dumps(r))
            return
        if main_sha() != sha:
            update(sha, "SUPERSEDED", imageId=image, archiveSha256=archive)
            return
        require(r["phase"] != "FAILED" or r.get("retrySafe") is True, "inspect failed receipt before retry")
        unit = "subboost-fork-" + sha + "-" + transfer
        dump(inflight, {"sourceSha": sha})
        if r["phase"] != "ABSENT":
            # Preserve attempt history separately; the active receipt describes only this attempt.
            dump(RECORDS / (sha + ".previous-" + transfer + ".json"), r)
        queued = {"sourceSha": sha, "phase": "QUEUED", "unit": unit, "imageId": image, "archiveSha256": archive,
                  "recoveryRequired": False, "retrySafe": False,
                  "updated": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        dump(RECORDS / (sha + ".json"), queued)
        result = subprocess.run(["systemd-run", "--unit=" + unit, "--collect", "--quiet", SELF, "worker", sha])
        if result.returncode:
            update(sha, "FAILED", error="systemd-run failed", retrySafe=True)
            raise CheckError("could not start worker")


if __name__ == "__main__":
    try:
        command(sys.argv[1:])
    except (CheckError, ValueError, OSError, KeyError, IndexError, subprocess.SubprocessError) as exc:
        sys.exit(str(exc) if isinstance(exc, CheckError) else "SubBoost release failed (" + type(exc).__name__ + ")")
