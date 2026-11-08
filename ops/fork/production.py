"""Local Docker Compose takeover. Only this module touches the existing app and database."""
import copy
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit

from image_identity import receipt_image_id, require_image_id, verify_release_graph
from smoke import PUBLIC, CheckError, business_session, check_site, private_json, require


def run(args, *, data=None, env=None):
    result = subprocess.run(args, input=data, env=env, capture_output=True)
    require(result.returncode == 0, "command failed: " + str(args[0]))
    return result.stdout


def pipe(left, right, output=None, source=None):
    # stderr may include SQL or connection strings. Retain only the failing tool.
    with subprocess.Popen(left, stdin=source, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as first:
        with subprocess.Popen(right, stdin=first.stdout, stdout=output or subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL) as second:
            first.stdout.close()
            code = second.wait()
        require(first.wait() == 0 and code == 0, "backup pipeline failed")


def sha256(path):
    value = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024**2), b""):
            value.update(block)
    return value.hexdigest()


def rooted_file(path, parent=None, private=False):
    file = Path(path)
    require(file.is_absolute() and file.resolve() == file and file.is_file() and file.stat().st_uid == 0
            and not file.stat().st_mode & (0o077 if private else 0o022)
            and (parent is None or file.is_relative_to(parent)), "unsafe host configuration file")
    return file


def identifier(name):
    require(re.fullmatch("[a-zA-Z_][a-zA-Z0-9_]{0,62}", name), "unsupported PostgreSQL identifier")
    return name


def container(cid):
    require(bool(cid), "missing container")
    return json.loads(run(["docker", "container", "inspect", cid]))[0]


def labels(c):
    return c["Config"]["Labels"] or {}


def environment(c):
    return dict(x.split("=", 1) for x in c["Config"]["Env"])


def network_aliases(c):
    return {name: set(net.get("Aliases") or []) for name, net in c["NetworkSettings"]["Networks"].items()}


def table_signature(schema):
    return {k: schema[k] for k in ("datdba", "encoding", "datcollate", "datctype", "datlocprovider",
                                   "daticulocale", "datcollversion", "datconnlimit", "datacl", "dattablespace")}


class Site:
    def __init__(self, config, base):
        self.config_path = rooted_file(config, private=True)
        cfg = self.cfg = private_json(config)
        self.base = base
        self.project = cfg["project"]
        self.root = Path(cfg["projectDir"])
        require(self.root.is_absolute() and self.root.resolve() == self.root and self.root.stat().st_uid == 0
                and not self.root.stat().st_mode & 0o022, "unsafe project directory")
        self.files = [rooted_file(path, self.root) for path in cfg["composeFiles"]]
        self.env_file = rooted_file(cfg["envFile"], self.root, private=True)
        self.credentials = rooted_file(cfg["businessCredentials"], private=True)
        self.backup_key = rooted_file(self.config_path.parent / "backup.key", private=True)
        require(re.fullmatch(r"[a-z0-9][a-z0-9_-]*", self.project) and self.files, "invalid Compose identity")
        self.local = cfg["localUrl"]
        require(re.fullmatch(r"http://127\.0\.0\.1:[0-9]+", self.local), "invalid local URL")
        self.port = cfg["candidatePort"]
        require(type(self.port) is int and 1024 <= self.port <= 65535 and self.port != urlsplit(self.local).port,
                "invalid candidate port")
        self.candidate_url = "http://127.0.0.1:" + str(self.port)
        self.db = cfg["database"]
        self.user = identifier(cfg["dbUser"])
        identifier(self.db)
        require(self.db not in ("postgres", "template0", "template1"), "unsupported database")
        self.net = cfg["dbNetwork"]
        self.candidate = ""
        self.candidate_id = ""
        self.reservation = ""
        self.temp_db = None
        self.temp_oid = None

    def compose_args(self, *args, env_file=None):
        cmd = ["docker", "compose", "--project-directory", str(self.root), "-p", self.project,
               "--env-file", str(env_file or self.env_file)]
        for file in self.files:
            cmd.extend(["-f", str(file)])
        return cmd + list(args)

    def cid(self, service):
        value = self.dc("ps", "--all", "--quiet", service).decode().strip()
        require(re.fullmatch(r"[a-f0-9]{12,64}", value), "ambiguous or missing Compose container: " + service)
        return value

    def dc(self, *args, env_file=None):
        return run(self.compose_args(*args, env_file=env_file))

    def dbcmd(self, *args):
        return ["docker", "exec", "-i", self.dbid, *args]

    def sql(self, db, query):
        return run(self.dbcmd("psql", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-U", self.user, "-d", db),
                   data=query.encode()).decode().strip()

    def db_meta(self, db):
        return json.loads(self.sql("postgres", "SELECT row_to_json(d) FROM pg_database AS d "
                                  "WHERE datname='" + identifier(db) + "'"))

    def counts(self, db):
        tables = ("LocalAdmin", "Subscription", "LocalTemplate", "_prisma_migrations")
        fields = ",".join('(SELECT count(*) FROM "' + table + '")' for table in tables)
        return self.sql(db, "SELECT " + fields +
                        ', (SELECT count(*) FROM "Subscription" s LEFT JOIN "LocalAdmin" a ON a.id=s."ownerId" '
                        'WHERE a.id IS NULL), (SELECT md5(string_agg(migration_name || checksum, '
                        "'' ORDER BY migration_name)) FROM _prisma_migrations WHERE finished_at IS NOT NULL)")

    def no_clients(self, db):
        require(self.sql("postgres", "SELECT count(*) FROM pg_stat_activity WHERE datname='" +
                         identifier(db) + "'") == "0", "unexpected database connections; keep writes stopped")

    def origin_health(self, expected):
        # Resolve the actual origin inside the connector network namespace.
        origin = self.cfg["tunnelOrigin"].rstrip("/")
        target = urlsplit(origin)
        require(target.scheme == "http" and target.hostname and not target.username and
                target.path in ("", "/") and not target.query and not target.fragment, "invalid Tunnel origin")
        connector = self.cfg["tunnelContainer"]
        if connector:
            connector_nets = set(network_aliases(container(connector)))
            if target.hostname in ("localhost", "127.0.0.1"):
                require(container(connector)["HostConfig"]["NetworkMode"] == "host" and
                        target.port == urlsplit(self.local).port, "connector loopback does not match host origin")
            else:
                require(any(target.hostname in aliases for name, aliases in self.cfg["appNetworks"].items()
                            if name in connector_nets) and target.port in (3000, None),
                        "Tunnel origin must use a durable app alias on a shared network")
            script = (
                "fetch(process.argv[1],{signal:AbortSignal.timeout(5000),redirect:'error'})"
                ".then(async r=>{if(r.status===200 && (await r.json()).ok===true)process.exit(0);process.exit(2)})"
                ".catch(()=>process.exit(2))"
            )
            result = subprocess.run(["docker", "run", "--rm", "--pull", "never", "--network", "container:" + connector,
                                     "--entrypoint", "node", self.old_image, "-e", script, origin + "/api/health/live"],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            require(result.returncode in (0, 2) and (result.returncode == 0) == expected, "Tunnel origin mismatch")
        else:
            # Host-network connector. Public and loopback checks supplement the operator's ingress inspection.
            require(target.hostname in ("localhost", "127.0.0.1") and target.port == urlsplit(self.local).port,
                    "host connector must use the pinned loopback port")
            from smoke import http
            try:
                ok = json.loads(http(self.local, "/api/health/live")[0]).get("ok") is True
            except CheckError:
                ok = False
            require(ok == expected, "host Tunnel origin mismatch")

    def assert_compose_identity(self, service, c):
        lbl = labels(c)
        require(c["State"]["Running"] and lbl.get("com.docker.compose.project") == self.project and
                lbl.get("com.docker.compose.service") == service and
                lbl.get("com.docker.compose.project.working_dir") == str(self.root),
                "running Compose identity mismatch: " + service)
        files_label = lbl.get("com.docker.compose.project.config_files", "")
        paths = files_label.split(",")
        if paths == [str(f) for f in self.files[:len(paths)]]:
            return
        # The upstream installer removes its temporary Compose file after copying it to the project.
        require(service in ("db", "cron") and
                re.fullmatch(r"/tmp/subboost-install\.[1-9][0-9]*/candidate-compose\.yml", files_label),
                "unexpected Compose files: " + service)
        digest = lbl.get("com.docker.compose.config-hash", "")
        require(re.fullmatch(r"[0-9a-f]{64}", digest) and
                f"{service} {digest}".encode() in self.dc("config", "--hash", service).splitlines(),
                "installer Compose service config changed: " + service)
        model = self.model["services"][service]
        image = run(["docker", "image", "inspect", "--format", "{{.Id}}", model["image"]]).decode().strip()
        require(c["Image"] == image, "installer service image changed: " + service)
        networks = {self.model["networks"][key]["name"] for key in model["networks"]}
        require(set(network_aliases(c)) == networks, "installer service networks changed: " + service)

    def preflight(self, readonly=False, target_image=None):
        self.model = json.loads(self.dc("config", "--format", "json"))
        require(self.model["name"] == self.project, "Compose project mismatch")
        if target_image is not None:
            if target_image == self.model["services"]["app"]["image"]:
                self.set_image("subboost-fork:preflight-" + secrets.token_hex(8), preview=True)
            self.set_image(target_image, preview=True)
        self.appid, self.dbid, self.cronid = [self.cid(s) for s in ("app", "db", "cron")]
        self.old = container(self.appid)
        db = container(self.dbid)
        cron = container(self.cronid)
        self.old_image = self.old["Image"]
        for svc, c in (("app", self.old), ("db", db), ("cron", cron)):
            self.assert_compose_identity(svc, c)
        mounts = [m for m in db["Mounts"] if m["Destination"] == "/var/lib/postgresql/data"]
        require(len(mounts) == 1 and mounts[0]["Type"] == "volume" and mounts[0]["Name"] == self.cfg["dbVolume"],
                "database volume mismatch")
        db_mounts = self.model["services"]["db"]["volumes"]
        require(any(m["type"] == "volume" and m["target"] == "/var/lib/postgresql/data" and
                    self.model["volumes"][m["source"]]["name"] == self.cfg["dbVolume"] for m in db_mounts),
                "Compose database mount differs from live volume")
        require(self.net in network_aliases(db) and self.net in network_aliases(self.old), "database network mismatch")
        self.appenv = self.model["services"]["app"]["environment"]
        actual_env = environment(self.old)
        require(self.appenv and all(actual_env.get(k) == v for k, v in self.appenv.items()) and
                all(self.appenv.get(k) for k in ("ENCRYPTION_KEY", "DATABASE_URL", "JWT_SECRET", "CRON_SECRET")) and
                self.appenv["APP_URL"].rstrip("/") == PUBLIC and
                self.appenv.get("TRUST_PROXY_HEADERS") == self.cfg["trustProxyHeaders"] and
                environment(cron)["CRON_SECRET"] == self.appenv["CRON_SECRET"], "application environment mismatch")
        pooled = urlsplit(self.appenv["DATABASE_URL"])
        require(pooled.hostname in network_aliases(db)[self.net] and pooled.port in (None, 5432) and
                unquote(pooled.path) == "/" + self.db and unquote(pooled.username or "") == self.user,
                "application points at a different database")
        for key in ("entrypoint", "command", "volumes", "secrets", "configs"):
            require(not self.model["services"]["app"].get(key), "unsupported app configuration: " + key)
        require(not self.old["Mounts"], "unrecorded app mounts")
        ports = self.old["NetworkSettings"]["Ports"].get("3000/tcp", [])
        require(ports == [{"HostIp": "127.0.0.1", "HostPort": str(urlsplit(self.local).port)}], "app port mismatch")
        self.assert_networks(self.old)
        dbinfo = self.db_meta(self.db)
        self.prod_oid = dbinfo["oid"]
        require(self.sql("postgres", "SELECT system_identifier FROM pg_control_system()") == str(self.cfg["dbSystemId"])
                and self.sql(self.db, "SHOW server_version_num").startswith("16"), "PostgreSQL identity mismatch")
        require(self.sql("postgres", "SELECT pg_get_userbyid(" + str(dbinfo["datdba"]) + ")") == self.user and
                dbinfo["datconnlimit"] == -1 and dbinfo["datacl"] is None and dbinfo["datlocprovider"] == "c" and
                self.sql("postgres", "SELECT count(*) FROM pg_db_role_setting WHERE setdatabase=" + str(self.prod_oid)) == "0"
                and self.sql("postgres", "SELECT spcname FROM pg_tablespace WHERE oid=" + str(dbinfo["dattablespace"])) == "pg_default",
                "database has nondefault permissions or locale settings; review recovery plan")
        self.other = self.other_containers()
        self.check_ingress()
        self.origin_health(True)
        self.check_cron_history(self.cronid)
        check_site(self.local)
        check_site(PUBLIC)
        if not readonly:
            self.session = business_session(self.local, self.credentials)
            check_site(self.local, self.session)
        return {"project": self.project, "deployPath": str(self.root), "imageId": self.old_image,
                "dbVolume": self.cfg["dbVolume"], "dbOid": self.prod_oid, "dbSystemId": self.cfg["dbSystemId"],
                "files": {str(f): sha256(f) for f in self.files}, "networks": self.cfg["appNetworks"],
                "counts": self.counts(self.db), "otherContainers": len(self.other)}

    def assert_networks(self, c):
        actual = network_aliases(c)
        require(set(actual) == set(self.cfg["appNetworks"]), "production network set changed")
        for name, aliases in self.cfg["appNetworks"].items():
            require(set(aliases) <= actual[name], "required production alias missing")
        configured = self.model["services"]["app"]["networks"]
        durable = {self.model["networks"][key]["name"]: set((net or {}).get("aliases") or []) | {"app", c["Name"].lstrip("/")}
                   for key, net in configured.items()}
        require(all(set(values) <= durable.get(name, set()) and name in durable
                    for name, values in self.cfg["appNetworks"].items()), "persist Tunnel networks/aliases in Compose first")

    def other_containers(self):
        ids = run(["docker", "ps", "-q", "--no-trunc"]).decode().split()
        return set(ids) - {c["Id"] for c in (container(self.cid("app")), container(self.dbid), container(self.cronid))}

    def check_ingress(self):
        for url in self.cfg["otherIngress"]:
            require(urlsplit(url).scheme in ("https", "http"), "invalid baseline ingress URL")
            run(["curl", "--silent", "--fail", "--max-time", "12", "--output", "/dev/null", url])

    def assert_active(self, image):
        self.preflight()
        require(self.old_image == image, "active image differs from receipt")

    def room(self, manifest, archive):
        pg_size = int(self.sql("postgres", "SELECT pg_database_size('" + self.db + "')"))
        store = Path(run(["docker", "info", "--format", "{{.DockerRootDir}}"]).decode().strip())
        voldir = Path(run(["docker", "volume", "inspect", "-f", "{{.Mountpoint}}", self.cfg["dbVolume"]]).decode().strip())
        # Aggregate requirements when backups, Docker and the data volume share a filesystem.
        disk = {}
        for path, size in ((self.base, pg_size + 128 * 1024**2), (voldir, pg_size * 2 + 128 * 1024**2),
                           (store, max(archive.stat().st_size * 5, 512 * 1024**2))):
            dev = path.stat().st_dev
            amount = disk.get(dev, 0) + size
            require(shutil.disk_usage(path).free > amount, "insufficient image or database restore space")
            disk[dev] = amount

    def image(self, m, archive):
        graph = verify_release_graph(archive, m)
        with archive.open("rb") as src:
            load = subprocess.run(["docker", "load"], stdin=src, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        require(load.returncode == 0, "docker load failed")
        data = json.loads(run(["docker", "image", "inspect", m["imageReference"]]))[0]
        host_id = require_image_id(data["Id"], graph)
        require(data["Architecture"] == "amd64" and data["Os"] == "linux" and
                data["Config"]["Labels"].get("org.opencontainers.image.revision") == m["sourceSha"] and
                data["Config"]["Labels"].get("org.opencontainers.image.source") == "https://github.com/krus1995/subboost" and
                environment(data).get("APP_BUILD_SHA") == m["sourceSha"], "image labels or platform mismatch")
        migration_digest = run(["docker", "run", "--pull", "never", "--rm", "--network", "none", "--entrypoint", "sh",
                                host_id, "-ec", "cd /app/local/prisma/migrations && "
                                "find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum | sha256sum"]).decode().split()[0]
        require(migration_digest == m["migrationTreeSha256"], "migration tree hash mismatch")
        return host_id

    def gpg(self, decrypt=False):
        args = ["gpg", "--batch", "--no-tty", "--pinentry-mode", "loopback", "--passphrase-file", str(self.backup_key)]
        return args + (["--decrypt"] if decrypt else ["--symmetric", "--cipher-algo", "AES256", "--output", "-"])

    def backup_files(self):
        snap = self.snapshot
        archived = [self.env_file, *self.files, self.config_path]
        with (snap / "config.tar.gpg").open("xb") as output:
            pipe(["tar", "-C", "/", "-cf", "-", *[str(f.relative_to("/")) for f in archived]], self.gpg(), output)
        with (snap / "db.dump.gpg").open("xb") as output:
            pipe(self.dbcmd("pg_dump", "-Fc", "-U", self.user, "-d", self.db), self.gpg(), output)
        self.dump_digest = sha256(snap / "db.dump.gpg")
        self.backup_input(self.dbcmd("pg_restore", "--file=/dev/null"))
        return {"backup": str(snap), "dbSha256": self.dump_digest,
                "configSha256": sha256(snap / "config.tar.gpg"), "oldImageId": self.old_image}

    def backup(self):
        snap = self.snapshot
        self.backup_files()
        self.old_counts = self.counts(self.db)
        meta = self.db_meta(self.db)
        self.temp_db = identifier("sbverify_" + secrets.token_hex(10))
        create = self.dbcmd("createdb", "-U", self.user, "--owner", self.user, "--template", "template0",
                            "--encoding", self.sql(self.db, "SHOW server_encoding"), "--lc-collate", meta["datcollate"],
                            "--lc-ctype", meta["datctype"], self.temp_db)
        run(create)
        temp = self.db_meta(self.temp_db)
        self.temp_oid = temp["oid"]
        require(table_signature(temp) == table_signature(meta) and self.temp_oid != self.prod_oid,
                "restore database identity mismatch")
        self.backup_input(self.dbcmd("pg_restore", "-U", self.user, "--exit-on-error", "--no-owner", "--no-privileges",
                                     "--dbname", self.temp_db))
        require(self.schema(self.db) == self.schema(self.temp_db), "restored schema, owners or ACLs differ")
        require(self.counts(self.temp_db) == self.old_counts, "restored table counts or migrations differ")
        info = {"backup": str(snap), "dbSha256": self.dump_digest, "configSha256": sha256(snap / "config.tar.gpg"),
                "schemaSha256": self.schema_digest(self.db),
                "sourceDb": self.db, "originalOid": self.prod_oid, "restoreDb": self.temp_db,
                "restoreOid": self.temp_oid, "dbOwner": self.user, "oldImageId": self.old_image,
                "keyFile": str(self.backup_key), "counts": self.old_counts}
        (snap / "backup.json").write_text(json.dumps(info) + "\n")
        return info

    def schema(self, db):
        data = run(self.dbcmd("pg_dump", "--schema-only", "-U", self.user, "-d", db))
        # Each modern pg_dump generates a fresh psql restrict key.
        return [line for line in data.splitlines() if not line.startswith((b"\\restrict ", b"\\unrestrict "))]

    def schema_digest(self, db):
        return hashlib.sha256(b"\n".join(self.schema(db))).hexdigest()

    def verify_old_recovery(self, receipt):
        phase = receipt.get("interruptedAt") or receipt.get("failedAt")
        require(phase != "ACTIVATING" and not receipt.get("everActivated"),
                "old-image fallback after ACTIVATING requires separate compatibility or recovery evidence")
        if phase != "CANDIDATE_RUNNING":
            return
        backup = Path(receipt["backup"])
        info = private_json(backup / "backup.json")
        require(backup.parent == self.base / "backups" and sha256(backup / "db.dump.gpg") == receipt["dbSha256"]
                and info["dbSha256"] == receipt["dbSha256"] and self.db_meta(self.db)["oid"] == info["restoreOid"]
                and self.schema_digest(self.db) == info["schemaSha256"] and self.counts(self.db) == info["counts"],
                "restored DB identity, schema or migration/data counts differ from the pre-migration backup")

    def backup_input(self, target):
        dump = self.snapshot / "db.dump.gpg"
        require(sha256(dump) == self.dump_digest, "database archive checksum changed")
        pipe(self.gpg(True) + [str(dump)], target)

    def clone_url(self):
        url = urlsplit(self.appenv["DATABASE_URL"])
        return url._replace(path="/" + self.temp_db).geturl()

    def start_candidate(self, image, dburl):
        cfg = {**self.appenv, "DATABASE_URL": dburl}
        spec = json.loads(run(["docker", "image", "inspect", image]))[0]["Config"]
        start = (spec.get("Entrypoint") or []) + (spec.get("Cmd") or [])
        require(start, "candidate has no startup command")
        cli = ["docker", "create", "--pull", "never", "--restart", "no", "--name", self.candidate,
               "--entrypoint", "sh", "--network", self.net, "--network-alias", self.candidate, "--publish",
               "127.0.0.1:" + str(self.port) + ":3000", "--label", "io.subboost.release=" + self.sha]
        for key in cfg:
            cli.extend(["--env", key])
        gate = 'while [ ! -f /tmp/subboost-start ]; do sleep 1; done; exec "$@"'
        self.candidate_id = run(cli + [image, "-ec", gate, "subboost-start", *start],
                                env={**os.environ, **cfg}).decode().strip()
        self.inspect_candidate(image)
        self.origin_health(False)
        run(["docker", "start", self.candidate_id])
        self.inspect_candidate(image)
        self.origin_health(False)
        actual = container(self.candidate_id)["NetworkSettings"]["Networks"][self.net]
        original = self.old["NetworkSettings"]["Networks"][self.net]
        if self.cfg["tunnelContainer"] and self.net in network_aliases(container(self.cfg["tunnelContainer"])):
            if actual["IPAddress"] == original["IPAddress"]:
                # Keep the old origin IP away from the candidate while connector DNS caches expire.
                require(not self.reservation, "could not isolate the old Tunnel origin IP")
                self.remove_candidate()
                self.reservation = run(["docker", "run", "-d", "--pull", "never", "--network", self.net,
                                        "--name", self.candidate + "-reserve", "--restart", "no", "--entrypoint", "sleep",
                                        "--label", "io.subboost.reservation=" + self.sha, self.old_image, "3600"]).decode().strip()
                self.start_candidate(image, dburl)
                return
        run(["docker", "exec", self.candidate_id, "touch", "/tmp/subboost-start"])
        check_site(self.candidate_url, self.session, 300)

    def inspect_candidate(self, image):
        c = container(self.candidate_id)
        require(c["Image"] == image, "candidate image drift")
        networks = network_aliases(c)
        require(c["Name"] == "/" + self.candidate and not any(k.startswith("com.docker.compose.") for k in labels(c))
                and labels(c).get("io.subboost.release") == self.sha and
                set(networks) == {self.net} and not (network_aliases(self.old)[self.net] & networks[self.net]) and
                c["HostConfig"]["RestartPolicy"]["Name"] == "no" and
                c["HostConfig"]["PortBindings"] == {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(self.port)}]},
                "candidate isolation check failed")
        target = urlsplit(self.cfg["tunnelOrigin"])
        require(target.hostname not in networks[self.net] and
                (target.hostname not in ("localhost", "127.0.0.1") or target.port != self.port),
                "candidate matches production origin")

    def remove_candidate(self):
        if self.candidate_id:
            c = container(self.candidate_id)
            require(c["Name"] == "/" + self.candidate and labels(c).get("io.subboost.release") == self.sha,
                    "candidate removal identity mismatch")
            run(["docker", "rm", "-f", self.candidate_id])
            self.candidate_id = ""

    def release_reservation(self):
        if self.reservation:
            c = container(self.reservation)
            require(c["Name"] == "/" + self.candidate + "-reserve" and labels(c).get("io.subboost.reservation") == self.sha,
                    "reservation identity mismatch")
            run(["docker", "rm", "-f", self.reservation])
            self.reservation = ""

    def cleanup_clone(self):
        if self.temp_db and self.temp_oid:
            require(self.db_meta(self.temp_db)["oid"] == self.temp_oid and self.temp_db.startswith("sbverify_") and
                    self.db_meta(self.db)["oid"] == self.prod_oid, "temporary database identity changed")
            run(self.dbcmd("dropdb", "-U", self.user, self.temp_db))
            self.temp_db = None

    def rollback(self):
        self.remove_candidate()
        self.no_clients(self.db)
        self.no_clients(self.temp_db)
        require(self.db_meta(self.db)["oid"] == self.prod_oid and self.db_meta(self.temp_db)["oid"] == self.temp_oid
                and self.counts(self.temp_db) == self.old_counts and
                sha256(self.snapshot / "db.dump.gpg") == self.dump_digest, "rollback target or archive changed")
        # Keep the failed database for diagnosis. The replacement came from an empty, verified restore.
        failed = identifier("sbfailed_" + secrets.token_hex(10))
        self.sql("postgres", 'BEGIN; ALTER DATABASE "' + self.db + '" RENAME TO "' + failed +
                 '"; ALTER DATABASE "' + self.temp_db + '" RENAME TO "' + self.db + '"; COMMIT;')
        require(self.db_meta(self.db)["oid"] == self.temp_oid and self.db_meta(failed)["oid"] == self.prod_oid and
                self.counts(self.db) == self.old_counts, "rollback database verification failed")
        (self.snapshot / "failed-db.json").write_text(json.dumps({"database": failed, "oid": self.prod_oid}))
        self.temp_db = None

    def start_original(self):
        self.release_reservation()
        require(container(self.appid)["Image"] == self.old_image, "old app no longer present")
        run(["docker", "start", self.appid])
        check_site(self.local, self.session, 300)
        self.origin_health(True)
        check_site(PUBLIC, self.session)
        run(["docker", "start", self.cronid])
        self.check_cron_history(self.cronid)

    def set_image(self, image, *, preview=False):
        require("SUBBOOST_IMAGE" not in os.environ, "unset SUBBOOST_IMAGE in the deployment process environment")
        raw = self.env_file.read_bytes()
        lines = raw.splitlines(keepends=True)
        indices = [i for i, line in enumerate(lines) if re.match(rb"^\s*(?:export\s+)?SUBBOOST_IMAGE\s*[=:]", line)]
        require(len(indices) == 1, "expected exactly one SUBBOOST_IMAGE assignment in the project env file")
        lines[indices[0]] = ("SUBBOOST_IMAGE=" + image + "\n").encode()
        expected = copy.deepcopy(self.model)
        expected["services"]["app"]["image"] = image
        with tempfile.NamedTemporaryFile(dir=self.env_file.parent, delete=False) as handle:
            staged = Path(handle.name)
            try:
                handle.write(b"".join(lines))
                handle.flush()
                unresolved = json.loads(self.dc("config", "--no-env-resolution", "--format", "json", env_file=staged))
                for name, service in unresolved["services"].items():
                    for entry in service.get("env_file", []):
                        path = entry["path"] if isinstance(entry, dict) else entry
                        require((self.root / path).resolve() != self.env_file,
                                "service " + name + " must use an env_file separate from the project env file")
                model = json.loads(self.dc("config", "--format", "json", env_file=staged))
                require(model["services"]["app"]["image"] == image, "SUBBOOST_IMAGE did not select the target app image")
                require(model == expected, "changing SUBBOOST_IMAGE affected other Compose settings")
                if not preview:
                    os.fsync(handle.fileno())
                    os.replace(staged, self.env_file)
                    require(json.loads(self.dc("config", "--format", "json")) == expected,
                            "active Compose model differs from the verified image change")
            finally:
                staged.unlink(missing_ok=True)

    def check_cron_history(self, cid):
        info = container(cid)
        started = info["State"]["StartedAt"]
        from datetime import datetime
        since = str(max(int(time.time()) - 5400, int(datetime.fromisoformat(started.replace("Z", "+00:00")).timestamp())))
        # Upstream curl does not append a newline. Docker can buffer its JSON until the next 360 s cycle.
        deadline = time.monotonic() + 420
        while time.monotonic() < deadline:
            require(container(cid)["State"]["Running"], "cron stopped")
            logs = subprocess.run(["docker", "logs", "--since", since, cid], capture_output=True, check=True)
            # Existing curl jobs print their successful JSON responses. Do not log those responses.
            data = logs.stdout.decode(errors="replace")
            if "one or more endpoints failed" in data or b"one or more endpoints failed" in logs.stderr:
                raise CheckError("cron reported failure")
            passed = {}
            pending = None
            for event in re.finditer(r"\[local-cron\][^\n]* POST /api/cron/(update-rule-index|update-subscriptions)\n", data):
                try:
                    payload, _ = json.JSONDecoder().raw_decode(data[event.end():].lstrip())
                    passed[event[1]] = payload.get("success") is True
                    pending = None
                except (ValueError, AttributeError):
                    pending = event[1]
            if passed == {"update-rule-index": True, "update-subscriptions": True} and pending is None:
                return
            # For the stock command, only success reaches sleep 360. Its failure branch sleeps 30 then exits.
            cmd = (info["Config"].get("Cmd") or [""])[-1]
            if (pending == "update-subscriptions" and passed.get("update-rule-index") and
                    cmd.count('|| failed=1') == 2 and 'if [ $failed -ne 0 ]' in cmd and
                    'sleep 30; exit 1; fi; sleep 360; done' in cmd):
                # Process names only, retained in memory; never print expanded command arguments.
                processes = run(["docker", "top", cid, "-eo", "pid,args"]).decode().splitlines()
                if any(re.fullmatch(r"\d+\s+(?:/[^ ]*/)?sleep\s+360", row.strip()) for row in processes):
                    return
            if pending == "update-subscriptions" and passed == {"update-rule-index": True, "update-subscriptions": True}:
                # A complete previous successful cycle is present. The fresh marker may still be buffered.
                if "curl:" not in logs.stderr.decode(errors="replace"):
                    return
            time.sleep(2)
        raise CheckError("no successful authenticated cron cycle observed")

    def cron_check(self):
        self.dc("up", "-d", "--no-deps", "--no-build", "--pull", "never", "cron")
        self.cronid = self.cid("cron")
        self.check_cron_history(self.cronid)

    def rehearsal(self):
        self.sha = secrets.token_hex(20)
        baseline = self.preflight(target_image="subboost-fork:" + self.sha)
        self.candidate = "subboost-candidate-" + self.sha
        self.snapshot = self.base / "backups" / ("rehearsal-" + self.sha)
        self.snapshot.mkdir(mode=0o700)
        # A rehearsal has no image archive to load. Still reserve backup and restore space.
        self.room({}, self.env_file)
        run(["docker", "tag", self.old_image, "subboost-previous:" + self.old_image.removeprefix("sha256:")])
        try:
            self.dc("stop", "cron", "app")
            require(not container(self.appid)["State"]["Running"] and not container(self.cronid)["State"]["Running"],
                    "rehearsal could not stop original writers")
            self.no_clients(self.db)
            self.origin_health(False)
            info = self.backup()
            self.start_candidate(self.old_image, self.clone_url())
        finally:
            try:
                self.remove_candidate()
                self.cleanup_clone()
            finally:
                self.start_original()
        require(self.db_meta(self.db)["oid"] == self.prod_oid, "original database changed")
        return {**info, "project": self.project, "dbSystemId": self.cfg["dbSystemId"],
                "dbVolume": self.cfg["dbVolume"], "files": baseline["files"],
                "envSha256": sha256(self.env_file), "productionUrl": PUBLIC, "smokePassed": True}

    def verify_rehearsal(self):
        evidence = private_json(self.base / "rehearsal.json")
        require(evidence["smokePassed"] is True and evidence["dbSystemId"] == self.cfg["dbSystemId"] and
                evidence["dbVolume"] == self.cfg["dbVolume"] and evidence["project"] == self.project,
                "complete the restore rehearsal on this host before deployment")
        prior = Path(evidence["backup"])
        require(prior.resolve() == prior and prior.parent == self.base / "backups" and
                sha256(prior / "db.dump.gpg") == evidence["dbSha256"], "rehearsal backup missing or changed")
        # For the initial takeover, bind the rehearsal to the exact old deployment.
        if (self.base / "current.json").exists():
            require(receipt_image_id(private_json(self.base / "current.json")) == self.old_image,
                    "live image does not match the last active receipt")
        else:
            require(evidence["oldImageId"] == self.old_image and evidence["originalOid"] == self.prod_oid
                    and evidence["envSha256"] == sha256(self.env_file) and
                    evidence["files"] == {str(p): sha256(p) for p in self.files}, "initial deployment drifted; repeat rehearsal")

    def deploy(self, m, path, status, current):
        self.sha = m["sourceSha"]
        self.candidate = "subboost-candidate-" + self.sha
        self.preflight(target_image=m["imageReference"])
        self.verify_rehearsal()
        archive = path / "image.tar.gz"
        self.room(m, archive)
        host_id = self.image(m, archive)
        run(["docker", "tag", self.old_image, "subboost-previous:" + self.old_image.removeprefix("sha256:")])
        self.snapshot = self.base / "backups" / (self.sha + "-" + secrets.token_hex(5))
        self.snapshot.mkdir(mode=0o700)
        status("PREPARED", backup=str(self.snapshot), oldImageId=self.old_image, productionImageId=host_id)
        if not current():
            status("SUPERSEDED")
            return
        writes_may_have_started = False
        candidate_may_have_migrated = False
        try:
            self.dc("stop", "cron", "app")
            require(not container(self.cronid)["State"]["Running"] and not container(self.appid)["State"]["Running"],
                    "could not stop original writers")
            self.no_clients(self.db)
            self.origin_health(False)
            info = self.backup()
            # Verify that the old image can decrypt a real restored subscription with the retained keys.
            self.start_candidate(self.old_image, self.clone_url())
            self.remove_candidate()
            require(self.db_meta(self.db)["oid"] == self.prod_oid, "source database changed during rehearsal")
            status("BACKED_UP", **info)
            status("CANDIDATE_RUNNING")
            candidate_may_have_migrated = True
            self.start_candidate(host_id, self.appenv["DATABASE_URL"])
            self.remove_candidate()
            self.release_reservation()
            status("ACTIVATING", recoveryRequired=True, everActivated=True)
            writes_may_have_started = True
            self.set_image(m["imageReference"])
            self.dc("up", "-d", "--no-deps", "--no-build", "--pull", "never", "app")
            active = container(self.cid("app"))
            require(active["Image"] == host_id, "active image drift")
            self.assert_networks(active)
            check_site(self.local, self.session, 300)
            self.origin_health(True)
            check_site(PUBLIC, self.session)
            self.cron_check()
            require(self.other.issubset(self.other_containers()), "another running container changed")
            self.check_ingress()
            self.cleanup_clone()
            status("ACTIVE", recoveryRequired=False, retrySafe=False)
        except BaseException:
            if writes_may_have_started:
                status("ACTIVATING", recoveryRequired=True, error="preserve live data; forward repair required")
            else:
                status("CANDIDATE_RUNNING" if candidate_may_have_migrated else "PREPARED", recoveryRequired=True)
                self.remove_candidate()
                if candidate_may_have_migrated:
                    self.rollback()
                else:
                    self.cleanup_clone()
                self.start_original()
                status("FAILED", recoveryRequired=False, retrySafe=True, restoredOriginal=True)
            raise
