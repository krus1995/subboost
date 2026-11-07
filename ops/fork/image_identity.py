"""Verify the one linux/amd64 image shared by Docker save's OCI and Docker manifests."""
import argparse
import hashlib
import json
import re
import tarfile
from pathlib import Path

from smoke import CheckError, require

OCI = "application/vnd.oci.image."
DOCKER = "application/vnd.docker."
MANIFEST_TYPES = (OCI + "manifest.v1+json", DOCKER + "distribution.manifest.v2+json")
CONFIG_TYPES = (OCI + "config.v1+json", DOCKER + "container.image.v1+json")


def read_archive(path):
    documents, blobs, seen = {}, {}, set()
    with tarfile.open(path, mode="r|gz", bufsize=256 * 1024) as stream:
        for member in stream:
            name = member.name.removeprefix("./")
            if member.isdir():
                continue
            require(member.isfile() and name not in seen, "unexpected archive entry")
            seen.add(name)
            source = stream.extractfile(member)
            if name in ("index.json", "manifest.json", "oci-layout", "repositories"):
                require(member.size <= 1024**2, "oversized image metadata")
                documents[name] = json.load(source)
                continue
            require(re.fullmatch("blobs/sha256/[a-f0-9]{64}", name), "unexpected Docker archive path")
            digest = hashlib.sha256()
            raw = None
            for chunk in iter(lambda: source.read(1024**2), b""):
                digest.update(chunk)
                if member.size <= 1024**2 and chunk.startswith(b"{"):
                    raw = chunk
            hex_digest = digest.hexdigest()
            require(hex_digest == name.split("/")[-1], "image blob digest mismatch")
            blobs["sha256:" + hex_digest] = (member.size, raw)
    return documents, blobs


def image_identity(archive, sha):
    require(re.fullmatch(r"[a-f0-9]{40}", sha), "invalid source revision")
    tag = "subboost-fork:" + sha
    documents, blobs = read_archive(archive)
    require(documents["oci-layout"].get("imageLayoutVersion") == "1.0.0", "unsupported OCI layout")
    index = documents["index.json"]
    require(index["schemaVersion"] == 2 and len(index["manifests"]) == 1, "expected one image manifest")
    entry = index["manifests"][0]
    annotation = entry["annotations"]
    require(annotation.get("io.containerd.image.name", "docker.io/library/" + tag) in (tag, "docker.io/library/" + tag)
            and annotation.get("org.opencontainers.image.ref.name") in (sha, tag, "docker.io/library/" + tag),
            "OCI image tag mismatch")
    if "platform" in entry:
        require(entry["platform"]["os"] == "linux" and entry["platform"]["architecture"] == "amd64",
                "manifest platform mismatch")

    def resolve(descriptor, media=None):
        digest = descriptor["digest"]
        require(digest in blobs and descriptor["size"] == blobs[digest][0], "image descriptor mismatch")
        if media:
            require(descriptor["mediaType"] in media and blobs[digest][1] is not None, "invalid image metadata descriptor")
            return json.loads(blobs[digest][1])
        return "blobs/sha256/" + digest.split(":")[1]

    manifest = resolve(entry, MANIFEST_TYPES)
    require(manifest["schemaVersion"] == 2 and manifest.get("mediaType") == entry["mediaType"], "invalid image manifest")
    config = resolve(manifest["config"], CONFIG_TYPES)
    layer_names = [resolve(layer) for layer in manifest["layers"]]
    docker = documents["manifest.json"]
    config_id = manifest["config"]["digest"]
    require(len(docker) == 1 and docker[0]["RepoTags"] == [tag] and
            docker[0]["Config"] == "blobs/sha256/" + config_id[7:] and docker[0]["Layers"] == layer_names,
            "Docker and OCI manifests identify different images")
    if "repositories" in documents:
        repositories = documents["repositories"]
        require(set(repositories) == {"subboost-fork"} and set(repositories["subboost-fork"]) == {sha},
                "unexpected saved repository tags")
    require(config["architecture"] == "amd64" and config["os"] == "linux" and
            config["config"]["Labels"].get("org.opencontainers.image.revision") == sha and
            config["config"]["Labels"].get("org.opencontainers.image.source") == "https://github.com/krus1995/subboost"
            and "APP_BUILD_SHA=" + sha in config["config"]["Env"], "image platform or revision mismatch")
    return {"configDigest": config_id, "manifestDigest": entry["digest"]}


def require_image_id(image_id, graph):
    require(image_id in (graph["configDigest"], graph["manifestDigest"]), "Docker image ID does not belong to archive")
    return image_id


def receipt_image_id(receipt):
    # Older receipts were written only when Docker's local ID matched the build ID.
    return receipt.get("productionImageId", receipt["imageId"])


def verify_release_graph(archive, release):
    graph = image_identity(archive, release["sourceSha"])
    if release["schemaVersion"] == 2:
        require(all(release.get(key) == value for key, value in graph.items()), "release and archive digests differ")
    else:
        require(release["schemaVersion"] == 1, "unsupported release format")
    require_image_id(release["imageId"], graph)
    return graph


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("sha")
    parser.add_argument("build_image_id")
    args = parser.parse_args()
    try:
        graph = image_identity(args.archive, args.sha)
        require_image_id(args.build_image_id, graph)
        print(json.dumps(graph))
    except (OSError, ValueError, TypeError, IndexError, KeyError, CheckError, tarfile.TarError) as error:
        parser.exit(1, "Image identity check failed: " + str(error) + "\n")
