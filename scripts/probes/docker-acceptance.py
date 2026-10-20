"""Linux uid1000, local immutable image only. No pull, build, host ports or real credentials."""
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import uuid

REPO = pathlib.Path(__file__).resolve().parents[2]
LOCAL_DAEMON = "unix:///var/run/docker.sock"
RUN_LABEL = "org.opencontext.acceptance-run"


def docker_command(config):
    # Explicit endpoint plus an allowlisted environment excludes DOCKER_HOST,
    # DOCKER_CONTEXT, TLS/config overrides and proxy settings from the caller.
    return ["docker", "--host", LOCAL_DAEMON, "--config", str(config)]


def docker_environment():
    return {"PATH": os.environ.get("PATH", os.defpath)}


def cleanup_probe(run, name, run_id):
    # A create response may time out after the daemon created the container.
    # Discover only this run's label/name and delete by verified immutable ID.
    ids = run(["container", "ls", "--all", "--quiet", "--no-trunc",
               "--filter", "label=" + RUN_LABEL + "=" + run_id,
               "--filter", "name=^/" + name + "$"]).split()
    if len(ids) > 1:
        raise RuntimeError("PROBE_CLEANUP_AMBIGUOUS")
    for container_id in ids:
        if not re.fullmatch(r"[a-f0-9]{64}", container_id):
            raise RuntimeError("PROBE_CLEANUP_INVALID_ID")
        metadata = json.loads(run(["container", "inspect", container_id]))
        if (len(metadata) != 1 or metadata[0].get("Id") != container_id
                or metadata[0].get("Name") != "/" + name
                or (metadata[0].get("Config", {}).get("Labels") or {}).get(RUN_LABEL) != run_id):
            raise RuntimeError("PROBE_CLEANUP_OWNERSHIP_MISMATCH")
        run(["container", "rm", "--force", container_id])


def validate_image(image):
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
        raise ValueError("LOCAL_IMAGE_ID_REQUIRED")
    return image


def main():
    if len(sys.argv) != 2:
        raise ValueError("USAGE: python3 scripts/probes/docker-acceptance.py sha256:LOCAL_IMAGE_ID")
    image = validate_image(sys.argv[1])
    if sys.platform != "linux" or os.getuid() != 1000:
        raise ValueError("LINUX_UID1000_REQUIRED: do not loosen data permissions")
    run_id = uuid.uuid4().hex
    name = "oc-acceptance-" + run_id
    with tempfile.TemporaryDirectory(prefix="oc-docker-acceptance-") as temporary:
        root = pathlib.Path(temporary)
        config = root / "docker-config"
        config.mkdir()
        (config / "config.json").write_text("{}\n")
        docker = docker_command(config)
        environment = docker_environment()

        def run(args, data=None):
            result = subprocess.run(docker + args, input=data, text=True, capture_output=True, timeout=45, env=environment)
            if result.returncode:
                # Do not emit raw process output or environment values.
                raise RuntimeError("DOCKER_PROBE_FAILED: " + args[0] + " exit=" + str(result.returncode))
            return result.stdout

        run(["image", "inspect", image])
        data = root / "data"
        data.mkdir(mode=0o700)
        owner = root / "owner"
        owner.write_text("synthetic-container-acceptance-owner-only")
        owner.chmod(0o600)
        script = (REPO / "scripts/probes/docker-runtime.mjs").read_text()
        fixture = (REPO / "plugins/session-connector/fixtures/codex-session.json").read_text()
        try:
            # Cleanup is armed before create, including an uncertain CLI outcome.
            run(["create", "--pull", "never", "--name", name,
                 "--label", RUN_LABEL + "=" + run_id,
                 "-e", "OPENCONTEXT_BIND_HOST=127.0.0.1", "--network", "none", "--read-only",
                 "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                 "--memory", "768m", "--cpus", "1", "--pids-limit", "128",
                 "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m,mode=1777",
                 "--mount", f"type=bind,src={data},dst=/var/lib/opencontext",
                 "--mount", f"type=bind,src={owner},dst=/run/opencontext-owner,readonly", image])
            run(["start", name])
            first = json.loads(run(["exec", "-i", "-e", "SMOKE_FIXTURE=" + fixture, name,
                                    "node", "--input-type=module"], script))
            run(["stop", "--time", "20", name])
            exit1 = json.loads(run(["inspect", "--format", "{{json .State}}", name]))["ExitCode"]
            assert exit1 == 0
            run(["start", name])
            second = json.loads(run(["exec", "-i", "-e", "SMOKE_FIXTURE=" + fixture,
                                     "-e", "SMOKE_EXPECTED=" + json.dumps(first), name,
                                     "node", "--input-type=module"], script))
            assert first["head"] == second["head"]
            run(["stop", "--time", "20", name])
            exit2 = json.loads(run(["inspect", "--format", "{{json .State}}", name]))["ExitCode"]
            assert exit2 == 0
            print(json.dumps({"result": "passed", "imageId": image, "first": first, "restart": second,
                              "stopExitCodes": [exit1, exit2], "network": "none", "hostPorts": 0,
                              "scope": "Synthetic imported files, CLI, MCP SDK, permissions and restart; no model, Compose or TLS"}, indent=2))
        finally:
            cleanup_probe(run, name, run_id)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, AssertionError, subprocess.TimeoutExpired) as error:
        print(str(error) if isinstance(error, (ValueError, RuntimeError)) else "PROBE_FAILED", file=sys.stderr)
        sys.exit(1)
