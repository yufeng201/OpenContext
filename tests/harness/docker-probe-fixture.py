"""Offline fault injection; never invokes a Docker daemon."""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "probe", pathlib.Path(__file__).resolve().parents[2] / "scripts/probes/docker-acceptance.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class DockerProbeSafety(unittest.TestCase):
    def test_endpoint_and_environment_ignore_remote_overrides(self):
        with patch.dict(os.environ, {"DOCKER_HOST": "tcp://remote.invalid:2376",
                                     "DOCKER_CONTEXT": "production", "DOCKER_TLS_VERIFY": "1",
                                     "DOCKER_CONFIG": "/real/config", "HTTPS_PROXY": "http://proxy.invalid"}):
            self.assertEqual(probe.docker_environment(), {"PATH": os.environ["PATH"]})
            self.assertEqual(probe.docker_command("/temporary/config"),
                             ["docker", "--host", "unix:///var/run/docker.sock", "--config", "/temporary/config"])

    def test_create_timeout_cleans_only_verified_run_id(self):
        calls = []
        own_id = "a" * 64
        state = {}

        def fake_run(command, **kwargs):
            self.assertEqual(command[1:3], ["--host", probe.LOCAL_DAEMON])
            self.assertEqual(set(kwargs["env"]), {"PATH"})
            args = command[5:]
            calls.append(args)
            output = ""
            if args[0] == "create":
                state["name"] = args[args.index("--name") + 1]
                state["label"] = args[args.index("--label") + 1].split("=", 1)[1]
                # The daemon created it, but the CLI failed to deliver its response.
                raise subprocess.TimeoutExpired(command, 45)
            if args[:2] == ["container", "ls"]:
                self.assertIn("label=" + probe.RUN_LABEL + "=" + state["label"], args)
                self.assertIn("name=^/" + state["name"] + "$", args)
                output = own_id + "\n"
            if args[:2] == ["container", "inspect"]:
                output = json.dumps([{"Id": own_id, "Name": "/" + state["name"],
                                      "Config": {"Labels": {probe.RUN_LABEL: state["label"]}}}])
            return subprocess.CompletedProcess(command, 0, output, "")

        with patch.object(sys, "argv", ["probe", "sha256:" + "b" * 64]), \
                patch.object(probe.os, "getuid", return_value=1000), \
                patch.object(probe.subprocess, "run", side_effect=fake_run):
            with self.assertRaises(subprocess.TimeoutExpired):
                probe.main()
        self.assertEqual(calls[-1], ["container", "rm", "--force", own_id])
        self.assertEqual(sum(c[:2] == ["container", "rm"] for c in calls), 1)

    def test_mismatched_label_name_or_id_never_deletes(self):
        own_id = "a" * 64
        for field in ("label", "name", "id"):
            calls = []
            metadata = {"Id": own_id, "Name": "/own", "Config": {"Labels": {probe.RUN_LABEL: "own-run"}}}
            if field == "label":
                metadata["Config"]["Labels"][probe.RUN_LABEL] = "other-run"
            if field == "name":
                metadata["Name"] = "/other"
            if field == "id":
                metadata["Id"] = "b" * 64

            def run(args):
                calls.append(args)
                return own_id if args[1] == "ls" else json.dumps([metadata])

            with self.assertRaisesRegex(RuntimeError, "OWNERSHIP_MISMATCH"):
                probe.cleanup_probe(run, "own", "own-run")
            self.assertFalse(any(c[1] == "rm" for c in calls))

    def test_absent_container_does_not_delete_anything(self):
        calls = []
        def run(args):
            calls.append(args)
            return ""
        probe.cleanup_probe(run, "own", "own-run")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][:2], ["container", "ls"])


if __name__ == "__main__":
    unittest.main()
