"""Fails the build when a baked-in DNS plugin would not satisfy the backend.

At startup, backend/setup.js runs `pip install` for the plugin of every DNS
certificate, with the requirements built by backend/lib/certbot.js from
backend/certbot/dns-plugins.json. The venv is read-only in the hardened image,
so that command must find everything already installed. This runs the same
requirements through pip with no index: it passes only if pip has nothing to
download or install.

Usage: check-plugins.py <dns-plugins.json> <plugin key>...
"""

import json
import subprocess
import sys
from importlib.metadata import version


def requirements(plugin, certbot_version):
    """Same strings as installPlugin() in backend/lib/certbot.js."""
    deps = plugin["dependencies"].replace("{{certbot-version}}", certbot_version).split()
    spec = plugin["version"].replace("{{certbot-version}}", certbot_version)
    return deps + [plugin["package_name"] + spec]


def main():
    plugins_file, keys = sys.argv[1], sys.argv[2:]
    with open(plugins_file, encoding="utf-8") as handle:
        plugins = json.load(handle)

    certbot_version = version("certbot")
    for key in keys:
        reqs = requirements(plugins[key], certbot_version)
        print(f"Checking {key}: {' '.join(reqs)}")
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--no-index", "--dry-run", *reqs],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0 or "Would install" in result.stdout:
            print(result.stdout + result.stderr)
            sys.exit(f"{key} is not satisfied by the locked requirements, update docker/hardened/certbot")


if __name__ == "__main__":
    main()
